import { AsyncLocalStorage } from 'node:async_hooks';
import { instructionText } from './instruction-text.mjs';
import { parseShareLocation } from './network-share-mounts.mjs';

const approvalContext = new AsyncLocalStorage();
const SHARE_WORDS = /\b(?:smb|nfs|nas|shares?|shared\s+folders?|network\s+folders?)\b|(?:smb|nfs):\/\/|\\\\|\/\//i;
export const SHARE_REMOVAL_REQUEST = /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:remove|delete|forget|disconnect|unmount)\b/i;
const quote = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function shareLocationInText(text) {
  const candidate = String(text).match(/(?:smb|nfs):\/\/[^\s`"<>]+|(?:\/\/|\\\\)[^\s`"<>]+|\b[a-z0-9.-]+:\/[^\s`"<>]+/i)?.[0];
  if (!candidate) return null;
  try { return parseShareLocation(candidate.replace(/[.!?,;]+$/, '')).location; }
  catch { return null; }
}

function references(share) {
  let basename = '';
  try { basename = decodeURIComponent(new URL(share.location).pathname).split('/').filter(Boolean).at(-1) || ''; } catch {}
  return [share.id, share.name, share.location, basename].filter(Boolean);
}

function shareReference(target) {
  return target
    .replace(/\s+(?:from|in)\s+(?:my\s+|the\s+)?(?:oe|openensemble)\b.*$/i, '')
    .replace(/^(?:(?:the|my|this|that|saved|smb|nfs|network|shared|share|folder|connection|export)\s+)+/i, '')
    .replace(/\s+(?:share|connection|export|shared folder)$/i, '')
    .replace(/^[`"']+|[`"'.!?]+$/g, '').trim();
}

function exactShares(target, shares) {
  const reference = shareReference(target);
  return shares.filter(share => references(share).some(name => name.toLowerCase() === reference.toLowerCase()));
}

const shareSubject = /^(?:(?:all|both|the|my|this|that|these|those|saved|smb|nfs|nas|network)\s+)*(?:shares?|exports?|connections?|shared\s+folders?|network\s+folders?)\b|\s(?:share|export|connection)$/i;
const containerClause = /\s+(?:from|in|on|inside|within|off|under)\s+/i;
function compoundShareSubject(target, shares) {
  const clauses = target.split(/\s+and\s+/i);
  return clauses.length > 1 ? clauses.find(clause => {
    const subject = clause.split(containerClause)[0];
    return shareSubject.test(subject) || exactShares(subject, shares).length;
  }) : null;
}

// "Remove X from the share" names files in a container, not the container.
// Keep this separate so a corrected file request can also cancel a pending
// share-removal choice without sending an old destructive choice to the model.
export function isNetworkShareFileRemoval(text, shares = []) {
  const instruction = instructionText(text).trim();
  if (!SHARE_REMOVAL_REQUEST.test(instruction)) return false;
  const target = instruction.replace(SHARE_REMOVAL_REQUEST, '').trim();
  if (exactShares(target, shares).length || compoundShareSubject(target, shares)) return false;
  const [subject, ...container] = target.split(containerClause);
  if (container.length && (SHARE_WORDS.test(container.join(' ')) || exactShares(container.join(' '), shares).length)
      && !shareSubject.test(subject)) return true;
  const location = shareLocationInText(target);
  if (location && shares.some(share => location.startsWith(`${share.location.replace(/\/$/, '')}/`))) return true;
  const reference = shareReference(target);
  if (shares.some(share => references(share).some(name => reference.toLowerCase().startsWith(`${name.toLowerCase()}/`)))) return true;
  if (/\b(?:share|export|connection)['’]s\s+(?:files?|contents?)\b/i.test(target)) return true;
  if (shareSubject.test(subject)) return false;
  return /^(?:(?:all|both|the|my|these|those|two|\d+)\s+)*(?:files?|contents?)\b/i.test(target)
    || /\.(?:md|txt|pdf|csv|json|docx?|xlsx?|png|jpe?g|gif|webp|mp[34]|wav|zip)(?:[`"']|\s|$)/i.test(target);
}

// History identifies a subject only. It can never approve a deletion.
export function detectNetworkShareRemoval(text, shares = [], history = []) {
  const instruction = instructionText(text).trim();
  if (!SHARE_REMOVAL_REQUEST.test(instruction)) return null;
  const verb = instruction.match(/\b(remove|delete|forget|disconnect|unmount)\b/i)[1].toLowerCase();
  if (isNetworkShareFileRemoval(instruction, shares)) return null;
  const rawTarget = instruction.replace(SHARE_REMOVAL_REQUEST, '').trim();
  const target = exactShares(rawTarget, shares).length ? rawTarget : (compoundShareSubject(rawTarget, shares) || rawTarget);
  const subject = exactShares(target, shares).length ? target : target.split(containerClause)[0];
  const reference = shareReference(subject);
  const location = shareLocationInText(target);
  const matches = shares.filter(share => share.location === location
    || references(share).some(name => name.toLowerCase() === reference.toLowerCase()));
  const recent = history.filter(row => row.role === 'user' && row.excludeFromModel !== true).slice(-8);
  // A filename merely mentioned alongside a share is not a share alias.
  const contextual = reference && recent.some(row => new RegExp(
    `\\b(?:share|export|connection)\\s+(?:(?:named|called)\\s+)?[\x60"']?${quote(reference)}(?:$|[^a-z0-9_.-])|(?:^|[^a-z0-9_.-])${quote(reference)}[\x60"']?\\s+(?:share|export|connection)\\b`, 'i',
  ).test(instructionText(row.content)));
  const pronoun = /^(?:it|this|that|the share|that share|this share)$/i.test(target.replace(/[.!?]+$/, ''));
  const previous = instructionText(recent.at(-1)?.content);
  const previousShareRequest = /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:connect|mount|disconnect|unmount|remove|delete|forget)\b/i.test(previous)
    && SHARE_WORDS.test(previous) && !isNetworkShareFileRemoval(previous, shares);
  if (!SHARE_WORDS.test(subject) && !matches.length && !contextual && !(pronoun && previousShareRequest)) return null;
  const record = matches.length === 1 ? matches[0]
    : (pronoun && shares.length === 1 ? shares[0] : null);
  return {
    reference: record?.name || reference || target,
    shareId: record?.id || null,
    location: record?.location || location,
    forget: !['disconnect', 'unmount'].includes(verb),
  };
}

export function runWithShareDeletionApproval(approval, fn) {
  return approvalContext.run(approval, fn);
}
export function getShareDeletionApproval(userId) {
  const approval = approvalContext.getStore();
  return approval?.userId === userId ? approval : null;
}
