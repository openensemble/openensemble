// Minimal WebDFU 1.1 download client over WebUSB.
// Supports: detach (if needed), DNLOAD chunked write, GETSTATUS poll, MANIFEST.
// Does not implement: UPLOAD, DFUSE extensions, alt-setting selection beyond a single interface.
//
// Spec: USB Device Class Specification for Device Firmware Upgrade, Revision 1.1
// (https://www.usb.org/sites/default/files/DFU_1.1.pdf)

const DFU_DETACH    = 0x00;
const DFU_DNLOAD    = 0x01;
const DFU_GETSTATUS = 0x03;
const DFU_CLRSTATUS = 0x04;
const DFU_ABORT     = 0x06;

export const dfuState = {
  appIDLE: 0,
  appDETACH: 1,
  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,
};

export class WebDFU {
  constructor(device, { interfaceNumber = 0, transferSize = 1024 } = {}) {
    this.device = device;
    this.interfaceNumber = interfaceNumber;
    this.transferSize = transferSize;
  }

  static async requestDevice(filters) {
    if (!navigator.usb) throw new Error('WebUSB not available');
    return await navigator.usb.requestDevice({ filters });
  }

  async open({ preferName, forceAlt, log } = {}) {
    if (!this.device.opened) await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);

    // Dump what Chrome surfaces for this device — alts can come back without
    // an alternateSetting field on some Chrome versions / odd descriptors.
    const dump = [];
    for (const iface of this.device.configuration.interfaces) {
      const alts = (iface.alternates || []).map((a, idx) => ({
        idx,
        alternateSetting: a.alternateSetting,
        interfaceClass: a.interfaceClass,
        interfaceSubclass: a.interfaceSubclass,
        interfaceProtocol: a.interfaceProtocol,
        interfaceName: a.interfaceName || null,
      }));
      dump.push({ interfaceNumber: iface.interfaceNumber, alts });
    }
    if (log) log('Device interfaces: ' + JSON.stringify(dump));

    // Collect DFU targets (class 0xFE / subclass 0x01) across all
    // interfaces and alt-settings. XMOS XVF3800 = 3 alts on iface 0:
    // Factory(0), Upgrade(1), DataPartition(2). Factory is read-only.
    const targets = [];
    for (const iface of this.device.configuration.interfaces) {
      const alts = iface.alternates || [];
      alts.forEach((alt, idx) => {
        if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
          targets.push({ iface, alt, idx });
        }
      });
    }
    if (targets.length === 0) {
      throw new Error('No DFU target (class 0xFE / subclass 0x01) on this device');
    }

    let chosen = null;

    // (1) forceAlt overrides everything — direct numeric pick.
    if (typeof forceAlt === 'number') {
      chosen = targets.find(t => (t.alt.alternateSetting ?? t.idx) === forceAlt);
    }
    // (2) name match (interfaceName populated).
    if (!chosen && preferName) {
      chosen = targets.find(t => (t.alt.interfaceName || '').toLowerCase().includes(preferName.toLowerCase()));
    }
    // (3) prefer alt-setting 1; fall back to index 1; never alt 0 unless it's
    //     the only thing on offer.
    if (!chosen) {
      const byAlt1 = targets.find(t => t.alt.alternateSetting === 1);
      if (byAlt1) chosen = byAlt1;
    }
    if (!chosen && targets.length > 1) {
      chosen = targets[Math.min(1, targets.length - 1)];
    }
    if (!chosen) chosen = targets[0];

    this.interfaceNumber  = chosen.iface.interfaceNumber;
    // Use the declared alternateSetting if Chrome gave us one, otherwise the
    // array index — selectAlternateInterface accepts either path because the
    // device validates against its own descriptor, not Chrome's metadata.
    this.alternateSetting = (chosen.alt.alternateSetting !== undefined && chosen.alt.alternateSetting !== null)
      ? chosen.alt.alternateSetting
      : chosen.idx;
    this.interfaceName    = chosen.alt.interfaceName || `iface${this.interfaceNumber}.alt${this.alternateSetting}`;

    try { await this.device.claimInterface(this.interfaceNumber); }
    catch (e) { throw new Error(`claimInterface ${this.interfaceNumber} failed: ${e.message}`); }
    this.altSetActual = 0; // default after claimInterface
    if (this.alternateSetting !== 0) {
      try {
        await this.device.selectAlternateInterface(this.interfaceNumber, this.alternateSetting);
        this.altSetActual = this.alternateSetting;
        if (log) log(`SET_INTERFACE → alt ${this.alternateSetting} OK`);
      } catch (e) {
        // Some XMOS DFU firmwares STALL SET_INTERFACE even though the
        // descriptor advertises multiple alts (partition router is
        // vendor-specific). Try the raw control transfer; if THAT fails
        // too, warn and continue on alt 0 — the device may write to the
        // currently-active partition regardless.
        try {
          await this.device.controlTransferOut({
            requestType: 'standard',
            recipient: 'interface',
            request: 0x0B,
            value: this.alternateSetting,
            index: this.interfaceNumber,
          });
          this.altSetActual = this.alternateSetting;
          if (log) log(`SET_INTERFACE (raw) → alt ${this.alternateSetting} OK`);
        } catch (e2) {
          if (log) log(`WARN: alt-set to ${this.alternateSetting} rejected (${e.message}). Continuing on alt 0.`);
          this.altSetActual = 0;
        }
      }
    }
  }

  async close() {
    try { await this.device.releaseInterface(this.interfaceNumber); } catch (_) {}
    try { await this.device.close(); } catch (_) {}
  }

  async _controlOut(request, value, data) {
    return await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request,
      value,
      index: this.interfaceNumber,
    }, data);
  }

  async _controlIn(request, length) {
    return await this.device.controlTransferIn({
      requestType: 'class',
      recipient: 'interface',
      request,
      value: 0,
      index: this.interfaceNumber,
    }, length);
  }

  async getStatus() {
    const result = await this._controlIn(DFU_GETSTATUS, 6);
    if (result.status !== 'ok' || result.data.byteLength !== 6) {
      throw new Error('DFU_GETSTATUS failed');
    }
    const d = new Uint8Array(result.data.buffer);
    return {
      status: d[0],
      pollTimeout: d[1] | (d[2] << 8) | (d[3] << 16),
      state: d[4],
      iString: d[5],
    };
  }

  async clearStatus() { await this._controlOut(DFU_CLRSTATUS, 0); }
  async abort()       { await this._controlOut(DFU_ABORT, 0); }

  async _pollUntilIdle(target, log) {
    let i = 0;
    while (true) {
      const s = await this.getStatus();
      if (log) log(`  poll[${i}]: status=${s.status} state=${s.state} pollTimeout=${s.pollTimeout}`);
      if (s.state === dfuState.dfuERROR) throw new Error(`DFU error status=${s.status} state=${s.state}`);
      if (s.state === target) return s;
      // Guard against runaway loops if the device returns an unexpected state
      // with pollTimeout=0 — sleep a minimum 50 ms between polls.
      const wait = Math.max(s.pollTimeout, 50);
      await new Promise(r => setTimeout(r, wait));
      if (++i > 200) throw new Error(`poll stuck in state=${s.state} after 200 iterations`);
    }
  }

  async download(bin, { onProgress, log } = {}) {
    const dbg = (msg) => { if (log) log(msg); };
    // Make sure we're in dfuIDLE before starting.
    let s = await this.getStatus();
    dbg(`Initial DFU status: status=${s.status} state=${s.state} pollTimeout=${s.pollTimeout}`);
    if (s.state === dfuState.dfuERROR) { await this.clearStatus(); dbg('Cleared error'); }
    if (s.state !== dfuState.dfuIDLE && s.state !== dfuState.dfuDNLOAD_IDLE) {
      try { await this.abort(); } catch (_) {}
      s = await this.getStatus();
      dbg(`Post-abort status: status=${s.status} state=${s.state}`);
      if (s.state !== dfuState.dfuIDLE) throw new Error(`Not in dfuIDLE (state=${s.state})`);
    }

    const total = bin.byteLength;
    let offset = 0;
    let block = 0;
    while (offset < total) {
      const end = Math.min(offset + this.transferSize, total);
      const chunk = bin.slice(offset, end);
      const out = await this._controlOut(DFU_DNLOAD, block & 0xFFFF, chunk);
      if (out.status !== 'ok') throw new Error(`DNLOAD block ${block} failed`);
      await this._pollUntilIdle(dfuState.dfuDNLOAD_IDLE);
      offset = end;
      block += 1;
      if (onProgress) onProgress(offset, total);
    }
    // Zero-length DNLOAD terminates download → device enters MANIFEST phase.
    await this._controlOut(DFU_DNLOAD, block & 0xFFFF, new ArrayBuffer(0));
    // Some devices reset/disappear during MANIFEST; tolerate transfer errors here.
    try {
      while (true) {
        const post = await this.getStatus();
        if (post.state === dfuState.dfuIDLE || post.state === dfuState.dfuMANIFEST_WAIT_RESET) break;
        if (post.pollTimeout > 0) await new Promise(r => setTimeout(r, post.pollTimeout));
      }
    } catch (_) {
      // Device dropped off bus during MANIFEST — normal for some firmware.
    }
  }
}
