/** Current attention is per profile and includes conversations in every project. */
export async function userInterruptionContext(userId, config, now = Date.now()) {
  const { getActiveStreams } = await import('../../chat-dispatch/slot-registry.mjs');
  const activeChat = getActiveStreams(userId, { allProjects: true }).length > 0;
  let calendarBusy = false;
  if (config?.sources?.calendar) {
    const { readMirror } = await import('../calendar-mirror.mjs');
    const calendar = readMirror(userId);
    if (calendar && now - calendar.fetchedAt < 10 * 60_000) {
      calendarBusy = calendar.events?.some(event => event.transparency !== 'transparent' && event.selfResponse !== 'declined'
        && Date.parse(event.start?.dateTime || '') <= now && Date.parse(event.end?.dateTime || '') > now) || false;
    }
  }
  return { activeChat, calendarBusy, occupied: activeChat || calendarBusy };
}
