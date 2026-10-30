---
title: Desktop app
nav_order: 2.5
permalink: /desktop/
description: Download OpenEnsemble Desktop for Windows or Linux, with updates you choose when to install.
---

# OpenEnsemble Desktop

Chat with your OE server, work with local files, and copy files between this
computer and your OE account. The desktop app connects to an existing server.

<link rel="stylesheet" href="{{ site.baseurl }}/assets/desktop-downloads.css">
<section class="desktop-download-card" data-desktop-downloads data-release-api="github" aria-label="Download OpenEnsemble Desktop">
  <h3>Download the desktop app</h3>
  <p>Available for Windows and Linux x64 computers.</p>
  <a href="https://github.com/openensemble/desktop/releases">View desktop releases</a>
</section>
<script type="module" src="{{ site.baseurl }}/assets/desktop-downloads.js"></script>

## Install and connect

On **Windows**, open the downloaded `.exe` and follow the installer. Open
OpenEnsemble from the Start menu or desktop shortcut.

On **Linux**, save the `.AppImage` in a folder you own, such as `~/Applications`.
Open its Properties, allow it to run as a program, then double-click it.
Alternatively, run `chmod +x` on the downloaded file and launch it. Keep that
folder writable so the app can update itself.

Choose your server from the automatic network search, or enter its address,
then sign in with your OE account. Prefer the server's HTTPS address.

## Updates are your choice

The app checks for a new version shortly after startup and every six hours.
When an update is available, save your work and choose **Update and restart**.
It downloads and verifies the release, replaces the installed app, and reopens.
Settings, sign-in storage, and local files stay in their existing locations.
Closing the app without accepting the update does not install it.

Use **App updates → Check for updates** to check immediately. Source launches
do not update themselves; on Linux, run the AppImage to enable updates.

See the [desktop guide]({{ site.baseurl }}/guide/desktop-app/) for setup and
troubleshooting, or [release notes](https://github.com/openensemble/desktop/releases).
