// @ts-check

/**
 * RFC-safe serialization for manually-built email headers.
 *
 * Gmail's API accepts a base64url-encoded RFC 2822 message. Base64url protects
 * the transport payload, but it does not encode non-ASCII header values. Those
 * values still need RFC 2047 encoded-words (or an explicitly negotiated
 * internationalized-email transport). OE's raw Gmail builders use this helper;
 * Microsoft Graph and Nodemailer receive structured Unicode values instead and
 * must not be pre-encoded.
 */

const SUBJECT_HEADER_NAME = 'Subject';
const SUBJECT_HEADER_PREFIX = `${SUBJECT_HEADER_NAME}: `;
const ENCODED_WORD_PREFIX = '=?UTF-8?B?';
const ENCODED_WORD_SUFFIX = '?=';

// Nodemailer uses 52-character encoded-words as a conservative interoperability
// limit. RFC 2047 permits up to 75 characters, but 52 leaves ample room for the
// field name and continuation whitespace while keeping every physical line well
// below the 76-character recommendation.
const MAX_ENCODED_WORD_LENGTH = 52;
const MAX_BASE64_PAYLOAD_LENGTH = MAX_ENCODED_WORD_LENGTH
  - ENCODED_WORD_PREFIX.length
  - ENCODED_WORD_SUFFIX.length;
const MAX_UTF8_BYTES_PER_WORD = Math.floor(MAX_BASE64_PAYLOAD_LENGTH / 4) * 3;

/**
 * Replace only unpaired UTF-16 surrogates. String.prototype.toWellFormed would
 * do this too, but OE supports Node 18 where that API is not always available.
 *
 * @param {string} value
 * @returns {string}
 */
function toWellFormedText(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += '\ufffd';
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result += '\ufffd';
    } else {
      result += value[index];
    }
  }
  return result;
}

/**
 * Remove characters that could create a second physical header. Newlines in an
 * intended subject are rendered as spaces; all other forbidden controls are
 * removed. This happens before deciding whether RFC 2047 encoding is needed.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeEmailHeaderText(value) {
  return toWellFormedText(String(value ?? ''))
    // Invalid lone UTF-16 surrogates cannot be represented in UTF-8. The
    // replacement above is explicit rather than relying on Buffer's implicit one.
    .replace(/\r\n[ \t]+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ' ')
    .trim();
}

/**
 * Split Unicode text without cutting a UTF-8 sequence or UTF-16 surrogate pair.
 * Each chunk fits in one base64 RFC 2047 encoded-word.
 *
 * @param {string} value
 * @returns {string[]}
 */
function splitUtf8ForEncodedWords(value) {
  const chunks = [];
  let chunk = '';
  let chunkBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (chunk && chunkBytes + characterBytes > MAX_UTF8_BYTES_PER_WORD) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * Encode a Subject value when it contains non-ASCII text or would exceed the
 * conservative physical-line limit. Adjacent encoded-words are folded; RFC 2047
 * readers ignore the folding whitespace between them when displaying the value.
 * Ordinary short ASCII subjects remain byte-for-byte readable.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function encodeEmailSubject(value) {
  const subject = sanitizeEmailHeaderText(value);
  const shortPrintableAscii = /^[\x20-\x7e]*$/.test(subject)
    && SUBJECT_HEADER_PREFIX.length + subject.length <= 76
    // A literal encoded-word token in an otherwise ASCII subject would be
    // decoded by mail clients. Encode the whole value to preserve it exactly.
    && !/=\?[^?\s]+\?[bq]\?[^?]*\?=/i.test(subject);
  if (shortPrintableAscii) return subject;
  if (!subject) return '';

  return splitUtf8ForEncodedWords(subject)
    .map(chunk => `${ENCODED_WORD_PREFIX}${Buffer.from(chunk, 'utf8').toString('base64')}${ENCODED_WORD_SUFFIX}`)
    .join('\r\n ');
}

/**
 * Build a complete Subject header for a raw RFC email message.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function buildEmailSubjectHeader(value) {
  return `${SUBJECT_HEADER_PREFIX}${encodeEmailSubject(value)}`;
}
