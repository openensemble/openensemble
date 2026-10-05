// Skill drawers keep their original IDs and lifecycle; their buttons live here.
function prepareSkillDrawer(drawerId) {
  const drawer = $(drawerId);
  if (!drawer || drawer.dataset.skillPanel) return;
  drawer.dataset.skillPanel = 'true';
  drawer.inert = !drawer.classList.contains('open');
  const nav = document.createElement('div');
  nav.className = 'skill-drawer-nav';
  nav.innerHTML = '<button type="button" class="skill-back-btn" data-action="returnToSkills"><i data-lucide="arrow-left" aria-hidden="true"></i><span>All skills</span></button>';
  drawer.prepend(nav);
}

function filterSkillApps() {
  const query = ($('skillsSearch')?.value || '').trim().toLocaleLowerCase();
  let available = 0, matches = 0;
  document.querySelectorAll('#skillAppGrid .skill-app').forEach(btn => {
    const enabled = btn.style.display !== 'none';
    const text = (btn.dataset.skillSearch || btn.textContent).toLocaleLowerCase();
    btn.hidden = !enabled || !text.includes(query);
    if (enabled) available++;
    if (!btn.hidden) matches++;
  });
  const empty = $('skillsEmpty');
  if (empty) {
    empty.hidden = matches > 0;
    empty.textContent = available ? 'No skills match your search.' : 'No skill drawers are enabled for this profile.';
  }
}

function returnToSkills() {
  const source = document.querySelector('#skillAppGrid .skill-app.active');
  toggleDrawer('drawerSkills', 'sbtnSkills');
  if (source && !source.hidden && source.style.display !== 'none') source.focus({ preventScroll: true });
}

prepareSkillDrawer('drawerExpenses');
prepareSkillDrawer('drawerTutorToday');

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey) return;
  // Let skill-specific inputs and dialogs handle their own Escape behavior.
  const drawer = $(activeDrawerId);
  if (!drawer || (drawer.id !== 'drawerSkills' && !drawer.dataset.skillPanel)) return;
  if (event.target.closest('.modal, [role="dialog"]')) return;
  if (drawer.id === 'drawerSkills') {
    event.preventDefault();
    if ($('skillsSearch').value) {
      $('skillsSearch').value = '';
      filterSkillApps();
    } else closeAllDrawers();
  } else if (!event.target.matches('input, textarea, select') && !event.target.isContentEditable) {
    event.preventDefault();
    returnToSkills();
  }
});
