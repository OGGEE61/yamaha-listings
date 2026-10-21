/**
 * Small shared UI behaviours (no data logic):
 *  - phone filter toolbar open/close
 *  - re-fit the collapsible price chart when it is opened
 */

function toggleToolbar() {
  const toolbar = document.getElementById('toolbar');
  const button = document.getElementById('toolbarToggle');
  if (!toolbar || !button) return;
  const open = toolbar.classList.toggle('is-open');
  button.setAttribute('aria-expanded', String(open));
}

document.addEventListener('DOMContentLoaded', () => {
  // On phones the tab strip scrolls sideways; make sure the current page's tab is in view.
  const activeTab = document.querySelector('.nav-tab.active');
  if (activeTab) activeTab.scrollIntoView({ inline: 'center', block: 'nearest' });

  const chartSection = document.getElementById('chartSection');
  if (!chartSection) return;
  chartSection.addEventListener('toggle', () => {
    // Chart.js measured a hidden (0px) canvas while collapsed; re-measure on open.
    if (chartSection.open && typeof priceChart !== 'undefined' && priceChart) priceChart.resize();
  });
});
