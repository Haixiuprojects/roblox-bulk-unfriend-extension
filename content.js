(() => {
  'use strict';

  const TOOLBAR_ID = 'rbu-toolbar';
  const RUNNER_ID = 'rbu-runner';
  const CARD_ATTR = 'data-rbu-card';
  const CHECKBOX_CLASS = 'rbu-checkbox-wrap';
  const STORAGE_KEY = 'rbuJobV2';
  const MODE_KEY = 'rbuMode';
  const DEFAULT_DELAY = 1200;
  const PARALLEL_START_MESSAGE = 'RBU_START_PARALLEL';
  const PARALLEL_RESULT_MESSAGE = 'RBU_PROFILE_RESULT';
  const MIN_DELAY = 800;
  const MAX_DELAY = 10000;
  const PROFILE_WAIT_TIMEOUT = 18000;
  const AUTO_REFRESH_KEY = 'rbuAutoRefreshJobV2';
  const AUTO_RUN_KEY = 'rbuAutoRunEnabledV2';

  const selected = new Map();
  const autoProcessedIds = new Set();
  const directCardInFlight = new Set();
  const directCardCompleted = new Set();
  let isStarting = false;
  let observerStarted = false;
  let profileJobStarted = false;
  let parallelProfileStarted = false;
  let parallelMonitorTimer = null;
  let currentMode = 'normal';
  let autoRunEnabled = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function storageGet() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => resolve(result[STORAGE_KEY] || null));
    });
  }

  function storageSet(job) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: job }, resolve);
    });
  }

  function storageRemove() {
    return new Promise((resolve) => {
      chrome.storage.local.remove(STORAGE_KEY, resolve);
    });
  }

  function loadAutoRun() {
    return new Promise((resolve) => {
      chrome.storage.local.get([AUTO_RUN_KEY], (result) => {
        autoRunEnabled = result[AUTO_RUN_KEY] === true;
        resolve(autoRunEnabled);
      });
    });
  }

  function saveAutoRun(enabled) {
    autoRunEnabled = Boolean(enabled);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [AUTO_RUN_KEY]: autoRunEnabled }, resolve);
    });
  }

  function loadMode() {
    return new Promise((resolve) => {
      chrome.storage.local.get([MODE_KEY], (result) => {
        const storedMode = result[MODE_KEY];
        const mode = storedMode === 'auto-all' ? 'auto-all' : 'normal';
        currentMode = mode;
        resolve(mode);
      });
    });
  }

  function saveMode(mode) {
    currentMode = mode === 'auto-all' ? 'auto-all' : 'normal';
    return new Promise((resolve) => {
      chrome.storage.local.set({ [MODE_KEY]: currentMode }, resolve);
    });
  }

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, reason: 'no-response' });
      });
    });
  }

  const isVisible = (element) => {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0;
  };

  const cleanText = (value) => String(value || '').replace(/\s+/g, ' ');
  const normalizeName = (value) => cleanText(value).replace(/^@/, '').toLowerCase();
  const isFriendsPage = () => location.pathname === '/users/friends' || location.pathname === '/users/friends/';
  const currentProfileId = () => location.pathname.match(/^\/users\/(\d+)\/profile/i)?.[1] || null;
  const isExtensionElement = (element) => Boolean(element && element.closest(`#${TOOLBAR_ID}, #${RUNNER_ID}, .rbu-card-unfriend, .rbu-checkbox-wrap`));

  function getApp() {
    return document.querySelector('#friends-web-app');
  }

  function getUserIdFromHref(href) {
    const match = String(href || '').match(/\/users\/(\d+)\/profile/i);
    return match ? match[1] : null;
  }

  function findFriendCard(anchor) {
    const explicitCard = anchor.closest('li.avatar-card, .avatar-card, [data-testid="friend-card"], [data-testid="avatar-card"]');
    if (explicitCard) return explicitCard;

    let current = anchor;
    for (let level = 0; current && level < 8; level += 1, current = current.parentElement) {
      if (current.id === 'friends-web-app' || current.id === TOOLBAR_ID) break;
      const rect = current.getBoundingClientRect();
      const profileLinks = current.querySelectorAll('a[href*="/users/"][href*="/profile"]');
      const text = cleanText(current.innerText);
      if (profileLinks.length === 1 && rect.width >= 150 && rect.height >= 58 && text.length <= 320) {
        return current;
      }
    }
    return anchor.closest('li, article, [role="listitem"]') || anchor.parentElement;
  }

  function getFriendRecords() {
    const app = getApp();
    if (!app) return [];

    const records = [];
    const seenIds = new Set();
    const links = Array.from(app.querySelectorAll('a[href*="/users/"][href*="/profile"]'));

    for (const anchor of links) {
      const userId = getUserIdFromHref(anchor.getAttribute('href'));
      if (!userId || seenIds.has(userId)) continue;
      const card = findFriendCard(anchor);
      if (!card || card === app) continue;

      seenIds.add(userId);
      const cardText = cleanText(card.innerText);
      const handleMatch = cardText.match(/@([A-Za-z0-9_]+)/);
      const nameAnchor = Array.from(card.querySelectorAll('a[href*="/users/"][href*="/profile"]'))
        .find((candidate) => cleanText(candidate.textContent));
      const displayName = cleanText(nameAnchor?.textContent) || cleanText(anchor.textContent) || handleMatch?.[1] || `User ${userId}`;
      const username = handleMatch ? `@${handleMatch[1]}` : '';
      const profileUrl = new URL(anchor.getAttribute('href'), location.origin).href;
      records.push({ userId, displayName, username, profileUrl, card });
    }

    return records;
  }

  function getDelay() {
    const input = document.querySelector('#rbu-delay');
    const value = Number(input?.value);
    if (!Number.isFinite(value)) return DEFAULT_DELAY;
    return Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(value)));
  }

  function setStatus(message, kind = '', rootId = TOOLBAR_ID) {
    const status = document.querySelector(`#${rootId} .rbu-status`);
    if (!status) return;
    status.textContent = message;
    status.className = `rbu-status${kind ? ` rbu-${kind}` : ''}`;
  }

  function updateCount() {
    const count = document.querySelector('#rbu-count');
    if (count) count.textContent = String(selected.size);
    const runButton = document.querySelector('#rbu-run');
    if (runButton) runButton.disabled = isStarting || selected.size === 0;
  }

  function setControlsDisabled(disabled) {
    document.querySelectorAll(`#${TOOLBAR_ID} button:not(#rbu-stop), #${TOOLBAR_ID} input`).forEach((element) => {
      element.disabled = disabled;
    });
    document.querySelectorAll('.rbu-card-unfriend').forEach((element) => {
      element.disabled = disabled;
    });
    updateCount();
  }

  function toggleSelection(record, checkbox) {
    if (checkbox.checked) {
      selected.set(record.userId, record);
      record.card.classList.add('rbu-selected-card');
    } else {
      selected.delete(record.userId);
      record.card.classList.remove('rbu-selected-card');
    }
    updateCount();
  }

  function addCheckbox(record) {
    const { card, userId, displayName, username } = record;
    if (!card) return;

    if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';
    card.setAttribute(CARD_ATTR, userId);

    if (!card.querySelector(`.${CHECKBOX_CLASS}`)) {
      const wrapper = document.createElement('label');
      wrapper.className = CHECKBOX_CLASS;
      wrapper.title = `Piliin si ${displayName} (${username || 'username unavailable'})`;
      wrapper.addEventListener('click', (event) => event.stopPropagation());

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `Piliin si ${displayName}`);
      checkbox.checked = selected.has(userId);
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', () => toggleSelection(record, checkbox));

      wrapper.appendChild(checkbox);
      card.appendChild(wrapper);
    }

    const checkbox = card.querySelector(`.${CHECKBOX_CLASS} input`);
    if (checkbox) checkbox.checked = selected.has(userId);
    if (selected.has(userId)) card.classList.add('rbu-selected-card');
    else card.classList.remove('rbu-selected-card');
  }

  function ensureCardUnfriendButton(record) {
    const { card, userId, displayName } = record;
    if (!card || card.querySelector(`[data-rbu-unfriend-id="${userId}"]`)) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rbu-card-unfriend';
    button.dataset.rbuUnfriendId = userId;
    button.textContent = 'Unfriend';
    button.title = `Unfriend ${displayName}`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const liveRecord = getFriendRecords().find((candidate) => candidate.userId === userId);
      if (liveRecord) runDirectCardUnfriend(liveRecord);
    });
    card.appendChild(button);
  }

  function cardHasExactUser(record) {
    if (!record?.card || !record.userId || record.card.getAttribute(CARD_ATTR) !== record.userId) return false;
    const linkedIds = Array.from(record.card.querySelectorAll('a[href*="/users/"][href*="/profile"]'))
      .map((anchor) => getUserIdFromHref(anchor.getAttribute('href')))
      .filter(Boolean);
    return linkedIds.length > 0 && linkedIds.every((id) => id === record.userId);
  }

  function findCardUnfriendAction(card) {
    if (!card) return null;
    return findActionElement(card, ['unfriend', 'remove friend']);
  }

  function findCardMenuTrigger(card) {
    if (!card) return null;
    const candidates = Array.from(card.querySelectorAll('button, [role="button"]'))
      .filter((element) => isVisible(element) && !isExtensionElement(element));
    return candidates.find((element) => /menu|more|options|ellipsis|overflow|contextual/i.test([
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('hint'),
      element.className,
    ].filter(Boolean).join(' '))) || null;
  }

  function findOpenCardMenu() {
    const roots = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]'))
      .filter((element) => isVisible(element) && !isExtensionElement(element));
    for (const root of roots) {
      const action = findActionElement(root, ['unfriend', 'remove friend']);
      if (action) return { root, action };
    }
    return null;
  }

  async function openCardUnfriendAction(record) {
    const direct = findCardUnfriendAction(record.card);
    if (direct) return direct;

    const trigger = findCardMenuTrigger(record.card);
    if (!trigger) return null;
    clickLikeUser(trigger);
    const opened = await waitFor(findOpenCardMenu, 5000, 200);
    return opened?.action || null;
  }

  async function performDirectCardUnfriend(record) {
    const userId = String(record?.userId || '');
    if (!userId || directCardInFlight.has(userId) || directCardCompleted.has(userId)) {
      return { ok: false, reason: 'already-processing-or-completed' };
    }

    const liveRecord = getFriendRecords().find((candidate) => candidate.userId === userId);
    if (!liveRecord || !cardHasExactUser(liveRecord)) {
      return { ok: false, reason: 'card-identity-mismatch' };
    }

    directCardInFlight.add(userId);
    const card = liveRecord.card;
    card.classList.add('rbu-processing-card');
    const originalButton = card.querySelector(`[data-rbu-unfriend-id="${userId}"]`);
    if (originalButton) originalButton.disabled = true;

    try {
      const action = await openCardUnfriendAction(liveRecord);
      if (!action) return { ok: false, reason: 'official-card-unfriend-control-not-found' };

      clickLikeUser(action);
      await sleep(400);
      const dialog = await waitFor(findConfirmationDialog, 2500, 200);
      if (dialog) {
        const confirm = findActionElement(dialog, ['unfriend', 'remove friend', 'remove', 'confirm', 'yes']);
        if (confirm) {
          clickLikeUser(confirm);
          await sleep(900);
        }
      } else {
        await sleep(900);
      }

      const stillOpen = findOpenCardMenu();
      if (stillOpen?.action) return { ok: false, reason: 'card-unfriend-still-visible' };
      directCardCompleted.add(userId);
      selected.delete(userId);
      const checkbox = card.querySelector(`.${CHECKBOX_CLASS} input`);
      if (checkbox) checkbox.checked = false;
      card.classList.remove('rbu-selected-card');
      updateCount();
      return { ok: true };
    } finally {
      directCardInFlight.delete(userId);
      card.classList.remove('rbu-processing-card');
      if (originalButton?.isConnected) originalButton.disabled = isStarting;
    }
  }

  async function runDirectCardUnfriend(record, ask = true) {
    if (ask) {
      const confirmed = window.confirm(`I-unfriend si ${record.displayName} (${record.username || 'selected user'}) gamit ang official card action?`);
      if (!confirmed) return { ok: false, reason: 'cancelled-by-user' };
    }
    const result = await performDirectCardUnfriend(record);
    if (result.ok) setStatus(`Na-unfriend si ${record.displayName} mula sa card.`, 'success');
    else if (result.reason !== 'cancelled-by-user') setStatus(`Hindi na-unfriend si ${record.displayName}: ${result.reason}`, 'error');
    return result;
  }

  async function startDirectCardBatch() {
    if (isStarting) return;
    refreshCards();
    const records = getCheckedRecords().filter((record) => /^\d+$/.test(record.userId));
    if (!records.length) {
      setStatus('Walang checked friend card na ipoproseso.', 'error');
      return;
    }

    const modeLabel = currentMode === 'auto-all' ? 'Auto all' : 'Normal selected-users';
    const preview = records.slice(0, 8).map((record) => `${record.displayName} (${record.username || record.userId})`).join('\\n');
    const extra = records.length > 8 ? `\\n… at ${records.length - 8} pa.` : '';
    const confirmed = window.confirm(
      `I-unfriend ang ${records.length} checked user(s) sa ${modeLabel} gamit ang direct card action?\\n\\n${preview}${extra}\\n\\nWalang profile tabs. Bawat Unfriend action ay nakatali sa sariling card at user ID.`,
    );
    if (!confirmed) return;

    // Stop any older profile-tab run before starting the direct-card flow.
    await runtimeMessage({ type: 'RBU_STOP_PARALLEL' });
    isStarting = true;
    setControlsDisabled(true);
    let success = 0;
    const failed = [];

    for (const record of records) {
      if (!record.card?.isConnected || !cardHasExactUser(record)) {
        failed.push({ ...record, reason: 'card-identity-mismatch-before-click' });
        continue;
      }
      const result = await performDirectCardUnfriend(record);
      if (result.ok) success += 1;
      else if (result.reason !== 'cancelled-by-user') failed.push({ ...record, reason: result.reason });
      await sleep(getDelay());
    }

    isStarting = false;
    setControlsDisabled(false);
    selected.clear();
    document.querySelectorAll(`.${CHECKBOX_CLASS} input`).forEach((checkbox) => { checkbox.checked = false; });
    document.querySelectorAll('.rbu-selected-card').forEach((card) => card.classList.remove('rbu-selected-card'));

    if (currentMode === 'auto-all' && success > 0 && failed.length === 0) {
      setStatus(`Auto all complete: ${success}/${records.length}. Nire-refresh ang Friends page at ise-select ulit ang visible users…`, 'success');
      window.setTimeout(() => location.assign('/users/friends#!/friends'), 900);
    } else if (failed.length) {
      setStatus(`Direct-card done: ${success}/${records.length} successful, ${failed.length} failed.`, 'error');
    } else {
      setStatus(`Direct-card done: ${success}/${records.length} successful.`, 'success');
    }
  }

  function selectVisibleFriends(updateStatus = true) {
    const records = getFriendRecords();
    records.forEach((record) => {
      if (currentMode === 'auto-all' && autoProcessedIds.has(record.userId)) {
        selected.delete(record.userId);
        const processedCheckbox = record.card.querySelector(`.${CHECKBOX_CLASS} input`);
        if (processedCheckbox) processedCheckbox.checked = false;
        record.card.classList.remove('rbu-selected-card');
        return;
      }
      selected.set(record.userId, record);
      const checkbox = record.card.querySelector(`.${CHECKBOX_CLASS} input`);
      if (checkbox) checkbox.checked = true;
      record.card.classList.add('rbu-selected-card');
    });
    updateCount();
    if (updateStatus) setStatus(`${selected.size} visible friend(s) ang napili.`);
  }

  function getCheckedRecords() {
    return getFriendRecords().filter((record) => {
      const checkbox = record.card.querySelector(`.${CHECKBOX_CLASS} input`);
      return checkbox?.checked === true;
    });
  }

  function clearSelection() {
    selected.clear();
    document.querySelectorAll(`.${CHECKBOX_CLASS} input`).forEach((checkbox) => { checkbox.checked = false; });
    document.querySelectorAll('.rbu-selected-card').forEach((card) => card.classList.remove('rbu-selected-card'));
    updateCount();
  }

  function clearProcessedAutoCards(job) {
    if (currentMode !== 'auto-all' || !job?.autoRefresh) return;
    const failedIds = new Set((job.failed || []).map((item) => String(item.userId || '')));
    for (const item of job.items || []) {
      const userId = String(item.userId || '');
      if (!userId || failedIds.has(userId)) continue;
      autoProcessedIds.add(userId);
      selected.delete(userId);
      const card = getFriendRecords().find((record) => record.userId === userId)?.card;
      if (card) {
        const checkbox = card.querySelector(`.${CHECKBOX_CLASS} input`);
        if (checkbox) checkbox.checked = false;
        card.classList.remove('rbu-selected-card');
      }
    }
    updateCount();
  }

  function refreshCards() {
    const records = getFriendRecords();
    const liveById = new Map(records.map((record) => [record.userId, record]));
    selected.forEach((record, userId) => {
      const liveRecord = liveById.get(userId);
      if (liveRecord) selected.set(userId, liveRecord);
      else selected.delete(userId);
    });
    records.forEach(addCheckbox);
    if (currentMode === 'auto-all' && !isStarting) selectVisibleFriends(false);
    updateCount();
  }

  function makeButton(id, label, className = '') {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    return button;
  }

  function createToolbar() {
    if (document.getElementById(TOOLBAR_ID)) return;

    const toolbar = document.createElement('section');
    toolbar.id = TOOLBAR_ID;
    toolbar.setAttribute('aria-label', 'Roblox Bulk Unfriend Selector');

    const title = document.createElement('div');
    title.className = 'rbu-title';
    title.textContent = 'Bulk Unfriend Selector';

    const count = document.createElement('span');
    count.id = 'rbu-count';
    count.className = 'rbu-count';
    count.textContent = '0';
    title.appendChild(count);

    const subtitle = document.createElement('p');
    subtitle.className = 'rbu-subtitle';
    subtitle.textContent = 'Normal = selected cards; Auto all = visible cards; max 5 tabs; Auto-run loops after confirmation.';

    const modeRow = document.createElement('div');
    modeRow.className = 'rbu-mode-row';
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Mode';
    modeLabel.setAttribute('for', 'rbu-mode');
    const mode = document.createElement('select');
    mode.id = 'rbu-mode';
    mode.title = 'Normal = ikaw ang pipili; Auto all = lahat ng visible friends; max 5 profile tabs';
    mode.innerHTML = '<option value="normal">Normal — selected cards (max 5 tabs)</option><option value="auto-all">Auto all — visible + next page</option>';
    mode.value = currentMode;
    mode.addEventListener('change', async () => {
      await saveMode(mode.value);
      clearSelection();
      const autoRunControl = document.querySelector('#rbu-auto-run');
      if (autoRunControl) {
        autoRunControl.disabled = currentMode !== 'auto-all';
        autoRunControl.checked = autoRunEnabled && currentMode === 'auto-all';
      }
      if (currentMode === 'auto-all') {
        refreshCards();
        setStatus(autoRunEnabled
          ? 'Auto all + Auto-run: automatic na ang susunod na batch pagkatapos ng confirmation.'
          : 'Auto all mode: visible users ang automatic na ise-select.');
        if (autoRunEnabled) kickoffAutoRunIfEnabled();
      } else {
        if (autoRunControl) {
          autoRunControl.checked = false;
          saveAutoRun(false);
        }
        setStatus('Normal mode: ikaw ang pipili ng users gamit ang checkboxes.');
      }
    });
    modeRow.append(modeLabel, mode);

    const row = document.createElement('div');
    row.className = 'rbu-row';
    const selectAll = makeButton('rbu-select-all', 'Select visible');
    const clear = makeButton('rbu-clear', 'Clear');
    row.append(selectAll, clear);

    const delayLabel = document.createElement('label');
    delayLabel.className = 'rbu-delay';
    delayLabel.textContent = 'Delay (ms)';
    const delay = document.createElement('input');
    delay.id = 'rbu-delay';
    delay.type = 'number';
    delay.min = String(MIN_DELAY);
    delay.max = String(MAX_DELAY);
    delay.step = '100';
    delay.value = String(DEFAULT_DELAY);
    delay.title = `Minimum ${MIN_DELAY} ms`;
    delayLabel.appendChild(delay);
    row.appendChild(delayLabel);

    const run = makeButton('rbu-run', 'Unfriend selected', 'rbu-danger');
    run.disabled = true;
    const stop = makeButton('rbu-stop', 'Stop batch');

    const autoRow = document.createElement('label');
    autoRow.className = 'rbu-auto-row';
    const autoRun = document.createElement('input');
    autoRun.id = 'rbu-auto-run';
    autoRun.type = 'checkbox';
    autoRun.checked = autoRunEnabled && currentMode === 'auto-all';
    autoRun.disabled = currentMode !== 'auto-all';
    const autoText = document.createElement('span');
    autoText.textContent = 'Auto-run loop (huwag nang pindutin ang red button)';
    autoRow.append(autoRun, autoText);

    const status = document.createElement('div');
    status.className = 'rbu-status';
    status.textContent = 'Ready. I-scan ulit ang list kung may bagong cards na lumabas.';

    toolbar.append(title, subtitle, modeRow, row, run, stop, autoRow, status);
    document.body.appendChild(toolbar);

    selectAll.addEventListener('click', () => {
      refreshCards();
      selectVisibleFriends();
    });

    clear.addEventListener('click', () => {
      clearSelection();
      setStatus('Walang napiling friend.');
    });

    run.addEventListener('click', () => {
      startParallelBatch();
    });

    stop.addEventListener('click', async () => {
      await runtimeMessage({ type: 'RBU_STOP_PARALLEL' });
      await saveAutoRun(false);
      autoRun.checked = false;
      isStarting = false;
      setControlsDisabled(false);
      setStatus('Pinahinto ang active batch at isinara ang owned profile tabs.', 'error');
    });

    autoRun.addEventListener('change', async () => {
      if (!autoRun.checked) {
        await saveAutoRun(false);
        setStatus('Auto-run loop naka-off.');
        return;
      }
      if (currentMode !== 'auto-all') {
        autoRun.checked = false;
        return;
      }
      const confirmed = window.confirm('I-enable ang Auto-run loop? Pagkatapos ng unang confirmation, automatic na magse-select at mag-u-unfriend ng susunod na visible batches hanggang maubos o magkaroon ng error. Maaari mong pindutin ang Stop batch anumang oras.');
      if (!confirmed) {
        autoRun.checked = false;
        await saveAutoRun(false);
        return;
      }
      await saveAutoRun(true);
      refreshCards();
      selectVisibleFriends(false);
      setStatus('Auto-run loop naka-enable. Pinipili ang visible users at sisimulan ang batch…', 'success');
      startParallelBatch({ skipConfirm: true });
    });
  }

  function textMatches(element, patterns) {
    if (!isVisible(element) || isExtensionElement(element)) return false;
    const text = cleanText(element.textContent).toLowerCase();
    const aria = cleanText(element.getAttribute('aria-label')).toLowerCase();
    const title = cleanText(element.getAttribute('title')).toLowerCase();
    return patterns.some((pattern) => text === pattern || aria === pattern || title === pattern);
  }

  function findActionElement(root, patterns) {
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], a, li'));
    const exact = candidates.find((element) => textMatches(element, patterns));
    if (exact) return exact;

    return candidates.find((element) => {
      if (!isVisible(element) || isExtensionElement(element)) return false;
      const combined = `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`.toLowerCase();
      return patterns.some((pattern) => combined.includes(pattern));
    }) || null;
  }

  function clickLikeUser(element) {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  async function waitFor(check, timeout = PROFILE_WAIT_TIMEOUT, interval = 300) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = check();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  function getProfileIdentity() {
    const id = currentProfileId();
    const nameElement = document.querySelector('#profile-header-title-container-name');
    const usernameElement = document.querySelector('.stylistic-alts-username');
    return {
      userId: id,
      displayName: cleanText(nameElement?.textContent),
      username: normalizeName(usernameElement?.textContent),
    };
  }

  async function verifyProfileIdentity(item) {
    if (!item?.userId || !item?.profileUrl) return null;
    return waitFor(() => {
      const identity = getProfileIdentity();
      const expectedUsername = normalizeName(item.username);
      const expectedDisplayName = normalizeName(item.displayName);
      if (identity.userId !== String(item.userId)) return null;
      if (!identity.displayName || !identity.username) return null;
      if (expectedUsername && identity.username !== expectedUsername) return null;
      if (expectedDisplayName && identity.displayName !== expectedDisplayName) return null;
      return identity;
    }, PROFILE_WAIT_TIMEOUT, 300);
  }

  function findContextualMenu() {
    const dialog = document.querySelector('[role="dialog"][aria-label="Contextual menu"]');
    return isVisible(dialog) ? dialog : null;
  }

  function findProfileMenuButton() {
    const exact = document.querySelector('#user-profile-header-contextual-menu-button');
    if (isVisible(exact)) return exact;

    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((element) => isVisible(element) && !isExtensionElement(element));
    return candidates.find((element) => /contextual|menu|options|ellipsis|more|overflow/i.test([
      element.textContent,
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('hint'),
      element.className,
    ].filter(Boolean).join(' '))) || null;
  }

  function findVisibleUnfriend() {
    const menu = findContextualMenu();
    return menu ? findActionElement(menu, ['unfriend']) : null;
  }

  async function openProfileMenu() {
    const alreadyOpen = findVisibleUnfriend();
    if (alreadyOpen) return alreadyOpen;

    const menuButton = await waitFor(findProfileMenuButton);
    if (!menuButton) return null;
    clickLikeUser(menuButton);
    return waitFor(findVisibleUnfriend, 6000, 250);
  }

  function findConfirmationDialog() {
    return Array.from(document.querySelectorAll('[role="dialog"], .modal-dialog, .modal-content'))
      .find((element) => isVisible(element)
        && !isExtensionElement(element)
        && element.getAttribute('aria-label') !== 'Contextual menu') || null;
  }

  async function performProfileUnfriend() {
    const action = await openProfileMenu();
    if (!action) return { ok: false, reason: 'profile-menu-or-unfriend-not-found' };

    clickLikeUser(action);
    await sleep(500);

    const dialog = await waitFor(findConfirmationDialog, 2500, 200);
    if (dialog) {
      const confirm = findActionElement(dialog, ['unfriend', 'remove friend', 'remove', 'confirm', 'yes']);
      if (confirm) {
        clickLikeUser(confirm);
        await sleep(900);
      }
    } else {
      await sleep(900);
    }

    // The Unfriend menu item should no longer be visible after a successful action.
    // If the menu was left open and still exposes Unfriend, report a failure instead
    // of silently moving to the next selected user.
    if (findVisibleUnfriend()) return { ok: false, reason: 'unfriend-still-visible' };
    return { ok: true };
  }

  async function startBatch() {
    if (isStarting) return;
    refreshCards();
    const records = Array.from(selected.values()).filter((record) => record.card?.isConnected);
    if (!records.length) {
      setStatus('Walang napiling friend.', 'error');
      return;
    }

    const preview = records.slice(0, 8).map((record) => `${record.displayName} (${record.username})`).join('\n');
    const extra = records.length > 8 ? `\n… at ${records.length - 8} pa.` : '';
    const confirmed = window.confirm(
      `I-unfriend ang ${records.length} selected friend(s)?\n\n${preview}${extra}\n\nBubuksan ang profile ng bawat user at iki-click ang official Unfriend menu. Hindi na madaling maibabalik ang action.`,
    );
    if (!confirmed) return;

    isStarting = true;
    setControlsDisabled(true);
    const job = {
      version: 2,
      active: true,
      items: records.map(({ userId, displayName, username, profileUrl }) => ({ userId, displayName, username, profileUrl })),
      index: 0,
      done: 0,
      failed: [],
      delay: getDelay(),
      startedAt: new Date().toISOString(),
    };

    await storageSet(job);
    setStatus(`Naka-save ang queue. Pupunta sa profile 1/${job.items.length}…`);
    await sleep(350);
    location.assign(job.items[0].profileUrl);
  }

  function createProfileRunner(job) {
    if (document.getElementById(RUNNER_ID)) return;

    const runner = document.createElement('section');
    runner.id = RUNNER_ID;
    runner.setAttribute('aria-label', 'Roblox Bulk Unfriend Progress');

    const title = document.createElement('div');
    title.className = 'rbu-title';
    title.textContent = 'Bulk Unfriend running';

    const status = document.createElement('div');
    status.className = 'rbu-status';
    status.textContent = `Queue: ${job.index + 1}/${job.items.length}`;

    const note = document.createElement('p');
    note.className = 'rbu-subtitle';
    note.textContent = 'Profile page flow: menu → Unfriend → optional confirmation.';

    const stop = makeButton('rbu-stop', 'Stop queue');
    stop.addEventListener('click', async () => {
      const current = await storageGet();
      if (current?.active) {
        current.active = false;
        current.stopped = true;
        await storageSet(current);
      }
      runner.remove();
    });

    runner.append(title, status, note, stop);
    document.body.appendChild(runner);
  }

  async function advanceProfileJob(job, result) {
    const item = job.items[job.index];
    if (result.ok) {
      job.done += 1;
    } else {
      job.failed.push({ ...item, reason: result.reason });
    }
    job.index += 1;

    if (job.index >= job.items.length) {
      job.active = false;
      job.finishedAt = new Date().toISOString();
      await storageSet(job);
      setStatus(`Tapos. ${job.done} successful, ${job.failed.length} failed. Babalik sa Friends page…`, job.failed.length ? 'error' : 'success', RUNNER_ID);
      await sleep(1200);
      location.assign('https://www.roblox.com/users/friends#!/friends');
      return;
    }

    await storageSet(job);
    setStatus(`Successful: ${job.done}; failed: ${job.failed.length}. Susunod: ${job.index + 1}/${job.items.length}`, '', RUNNER_ID);
    await sleep(Math.max(MIN_DELAY, job.delay || DEFAULT_DELAY));
    location.assign(job.items[job.index].profileUrl);
  }

  function createParallelRunner(userId) {
    if (document.getElementById(RUNNER_ID)) return;

    const runner = document.createElement('section');
    runner.id = RUNNER_ID;
    runner.setAttribute('aria-label', 'Roblox Parallel Unfriend Progress');

    const title = document.createElement('div');
    title.className = 'rbu-title';
    title.textContent = 'Parallel tab active';

    const status = document.createElement('div');
    status.className = 'rbu-status';
    status.textContent = `Inihahanda ang user ${userId}…`;

    const note = document.createElement('p');
    note.className = 'rbu-subtitle';
    note.textContent = 'Official profile menu → Unfriend → optional confirmation. Isasara ang tab pagkatapos ng result.';

    const stop = makeButton('rbu-stop', 'Stop all parallel tabs');
    stop.addEventListener('click', async () => {
      await runtimeMessage({ type: 'RBU_STOP_PARALLEL' });
      setStatus('Pinahinto ang parallel queue.', 'error', RUNNER_ID);
    });

    runner.append(title, status, note, stop);
    document.body.appendChild(runner);
  }

  async function runParallelProfile(userId, item, ownerToken) {
    if (parallelProfileStarted) return;
    parallelProfileStarted = true;
    createParallelRunner(userId);
    setStatus(`Profile ${userId} loaded. Hinahanap agad ang Unfriend menu…`, '', RUNNER_ID);
    const result = await performProfileUnfriend();
    if (result.ok) setStatus('Na-click ang official Unfriend control; magsasara ang tab.', 'success', RUNNER_ID);
    else setStatus(`Hindi na-click ang Unfriend: ${result.reason}`, 'error', RUNNER_ID);
    await runtimeMessage({ type: PARALLEL_RESULT_MESSAGE, result, ownerToken: String(ownerToken || '') });
  }

  async function startParallelBatch({ skipConfirm = false } = {}) {
    if (isStarting) return;
    refreshCards();
    const checkedRecords = getCheckedRecords();
    const records = checkedRecords.filter((record) => (
      /^\d+$/.test(record.userId)
      && /^https:\/\/www\.roblox\.com\/users\/\d+\/profile(?:[?#].*)?$/i.test(record.profileUrl)
    ));
    if (!records.length) {
      setStatus('Walang valid na checked friend. I-check ang tamang cards at subukan ulit.', 'error');
      return;
    }

    const preview = records.slice(0, 8).map((record) => `${record.displayName} (${record.username})`).join('\\n');
    const extra = records.length > 8 ? `\\n… at ${records.length - 8} pa.` : '';
    const confirmed = skipConfirm || window.confirm(
      `Buksan ang ${Math.min(records.length, 5)} profile tab(s) muna at i-unfriend ang ${records.length} selected user(s) sa ${currentMode === 'auto-all' ? 'Auto all' : 'Normal selected-users'} mode?\\n\\n${preview}${extra}\\n\\nMaximum 5 tabs lang ang sabay-sabay; susunod ang natitira kapag may tab nang nagsara. Ang bawat tab ay gagamit ng official Roblox Unfriend menu at magsasara pagkatapos.`,
    );
    if (!confirmed) return;

    // Freeze an exact snapshot of the checked cards before any navigation starts.
    records.forEach((record) => selected.set(record.userId, record));
    isStarting = true;
    setControlsDisabled(true);
    const response = await runtimeMessage({
      type: PARALLEL_START_MESSAGE,
      items: records.map(({ userId, displayName, username, profileUrl }) => ({ userId, displayName, username, profileUrl })),
      delay: getDelay(),
      autoRefresh: currentMode === 'auto-all',
    });

    if (!response.ok) {
      isStarting = false;
      setControlsDisabled(false);
      setStatus(`Parallel tabs start failed: ${response.reason || 'unknown error'}`, 'error');
      return;
    }

    setStatus(`Binubuksan ang ${response.accepted || records.length} profile tab(s) sa background…`);
    monitorParallelJob();
  }

  async function autoSelectAfterRobloxUpdate(job) {
    if (currentMode !== 'auto-all' || !job?.autoRefresh || !job?.finishedAt || job.stopped) return false;
    const marker = `${job.ownerToken || 'job'}:${job.finishedAt}`;
    if (sessionStorage.getItem(AUTO_REFRESH_KEY) === marker) return true;
    sessionStorage.setItem(AUTO_REFRESH_KEY, marker);
    setStatus('Naghihintay sa Roblox auto-updated Friends list…', 'success');
    await sleep(1200);
    clearProcessedAutoCards(job);
    refreshCards();
    if (job.failed?.length) {
      if (!autoRunEnabled) {
        setStatus(`Auto all paused: ${job.failed.length} profile(s) failed. Failed cards remain selected for review.`, 'error');
        return true;
      }
      setStatus(`Auto-run remains enabled. ${job.failed.length} failed card(s) will retry automatically…`, 'error');
      await sleep(3000);
      refreshCards();
      if (selected.size) await startParallelBatch({ skipConfirm: true });
      else setStatus('Auto-run remains enabled and is waiting for the Roblox list update…', 'success');
      return true;
    }
    selectVisibleFriends(false);
    if (!autoRunEnabled) {
      setStatus(`${selected.size} bagong visible friend(s) ang auto-selected. I-enable ang Auto-run o pindutin ang red button para magpatuloy.`, 'success');
      return true;
    }
    if (!selected.size) {
      setStatus('Auto-run naka-enable pa rin; walang bagong visible friend cards. Maghihintay ito sa Roblox list update…', 'success');
      return true;
    }
    setStatus(`${selected.size} bagong visible friend(s) ang auto-selected. Awtomatikong sinisimulan ang susunod na batch…`, 'success');
    await sleep(500);
    await startParallelBatch({ skipConfirm: true });
    return true;
  }

  function findNextPageButton() {
    const app = getApp();
    if (!app) return null;
    const candidates = Array.from(app.querySelectorAll('button[title="right"], button[aria-label*="next" i], button[aria-label*="right" i]'));
    return candidates.find((button) => isVisible(button)
      && !button.disabled
      && button.getAttribute('aria-disabled') !== 'true'
      && !/disabled/i.test(button.className || '')) || null;
  }

  function pageSignature() {
    return getFriendRecords().map((record) => record.userId).join(',');
  }

  async function continueAutoAfterReturn() {
    if (currentMode !== 'auto-all') return;
    const response = await runtimeMessage({ type: 'RBU_GET_PARALLEL_JOB' });
    const job = response.job;
    if (!job?.finishedAt || job.active || !job.autoRefresh || job.stopped) return;
    if (job.failed?.length) {
      setStatus(`Auto loop stopped: ${job.failed.length} profile(s) failed. Review the page before retrying.`, 'error');
      return;
    }

    const marker = `${job.ownerToken || 'job'}:${job.finishedAt}`;
    if (sessionStorage.getItem(AUTO_REFRESH_KEY) !== marker) sessionStorage.setItem(AUTO_REFRESH_KEY, marker);
    if (sessionStorage.getItem(`${AUTO_REFRESH_KEY}:advanced`) === marker) return;

    const before = pageSignature();
    const nextButton = findNextPageButton();
    if (!nextButton) {
      clearSelection();
      setStatus(`Auto all complete: ${job.done || 0} users processed. Wala nang next page.`, 'success');
      sessionStorage.setItem(`${AUTO_REFRESH_KEY}:advanced`, marker);
      return;
    }

    sessionStorage.setItem(`${AUTO_REFRESH_KEY}:advanced`, marker);
    clearSelection();
    setStatus('Auto all complete. Nire-reset ang selection at pumupunta sa next page…', 'success');
    clickLikeUser(nextButton);
    const changed = await waitFor(() => {
      const after = pageSignature();
      return after && after !== before ? after : null;
    }, 15000, 400);

    if (!changed) {
      setStatus('Hindi nakita ang bagong page pagkatapos pindutin ang next arrow. Hinto muna ang Auto loop.', 'error');
      return;
    }

    refreshCards();
    await sleep(500);
    await startParallelBatch({ skipConfirm: true });
  }

  async function monitorParallelJob() {
    if (parallelMonitorTimer) return;

    const poll = async () => {
      const response = await runtimeMessage({ type: 'RBU_GET_PARALLEL_JOB' });
      const job = response.job;
      if (!job) {
        parallelMonitorTimer = null;
        return;
      }

      if (job.active) {
        const total = job.items?.length || 0;
        const processed = job.processed || 0;
        setStatus(`Parallel tabs: ${processed}/${total} finished; ${job.done || 0} successful, ${job.failed?.length || 0} failed.`);
        parallelMonitorTimer = window.setTimeout(poll, 1000);
        return;
      }

      isStarting = false;
      setControlsDisabled(false);
      const total = job.items?.length || 0;
      const failed = job.failed?.length || 0;
      parallelMonitorTimer = null;
      if (await autoSelectAfterRobloxUpdate(job)) {
        return;
      }
      if (job.stopped) setStatus(`Parallel queue stopped: ${job.done || 0}/${total} successful.`, 'error');
      else if (failed) setStatus(`Parallel done: ${job.done || 0}/${total} successful, ${failed} failed.`, 'error');
      else setStatus(`Parallel done: ${job.done || 0}/${total} successful. Visible users are selected again.`, 'success');
      parallelMonitorTimer = null;
    };

    await poll();
  }

  async function runProfileJob() {
    if (profileJobStarted) return;
    const job = await storageGet();
    if (!job?.active || !Array.isArray(job.items) || !job.items[job.index]) return;

    profileJobStarted = true;
    createProfileRunner(job);
    const item = job.items[job.index];
    const currentId = currentProfileId();
    if (currentId !== item.userId) {
      setStatus(`Inaayos ang queue navigation: ${item.displayName}…`, '', RUNNER_ID);
      location.assign(item.profileUrl);
      return;
    }

    setStatus(`Hinahanap ang profile menu para kay ${item.displayName}…`, '', RUNNER_ID);
    const result = await performProfileUnfriend();
    if (result.ok) {
      setStatus(`Na-click ang Unfriend para kay ${item.displayName}.`, 'success', RUNNER_ID);
    } else {
      setStatus(`Hindi na-click kay ${item.displayName}: ${result.reason}`, 'error', RUNNER_ID);
    }
    await advanceProfileJob(job, result);
  }

  async function showLastResult() {
    const job = await storageGet();
    if (job?.finishedAt && !job.active) {
      if (job.stopped) {
        setStatus(`Queue stopped. ${job.done} successful, ${job.failed.length} failed.`, 'error');
      } else if (job.failed?.length) {
        setStatus(`Tapos: ${job.done} successful, ${job.failed.length} failed. Piliin ulit ang failed users kung kailangan.`, 'error');
      } else if (job.done) {
        setStatus(`Tapos: ${job.done} user(s) ang na-process. I-refresh ang list para ma-verify.`, 'success');
      }
      return;
    }

    const parallelResponse = await runtimeMessage({ type: 'RBU_GET_PARALLEL_JOB' });
    const parallel = parallelResponse.job;
    if (parallel?.active) {
      setControlsDisabled(true);
      monitorParallelJob();
    } else if (parallel?.finishedAt && parallel.done) {
      parallelMonitorTimer = null;
      if (await autoSelectAfterRobloxUpdate(parallel)) return;
      if (parallel.stopped) setStatus(`Parallel queue stopped: ${parallel.done} successful, ${parallel.failed?.length || 0} failed.`, 'error');
      else if (parallel.failed?.length) setStatus(`Parallel done: ${parallel.done} successful, ${parallel.failed.length} failed. Visible users are selected again.`, 'error');
      else setStatus(`Parallel done: ${parallel.done} successful. Visible users are selected again.`, 'success');
    }
  }

  async function resumeIfNeeded() {
    const job = await storageGet();
    if (!job?.active || !job.items?.[job.index]) return;
    setControlsDisabled(true);
    setStatus(`May active queue: ${job.index + 1}/${job.items.length}. Ire-resume ang profile flow…`);
    await sleep(700);
    location.assign(job.items[job.index].profileUrl);
  }

  async function kickoffAutoRunIfEnabled() {
    if (currentMode !== 'auto-all' || !autoRunEnabled) return;
    const response = await runtimeMessage({ type: 'RBU_GET_PARALLEL_JOB' });
    if (response.job?.active) {
      setControlsDisabled(true);
      monitorParallelJob();
      return;
    }
    refreshCards();
    selectVisibleFriends(false);
    if (!selected.size) {
      setStatus('Auto-run naka-enable at naghihintay ng bagong visible friend cards…', 'success');
      return;
    }
    setStatus('Auto-run enabled: automatic na magsisimula ang selected visible batch…', 'success');
    await startParallelBatch({ skipConfirm: true });
  }

  async function startFriendsPage() {
    if (!getApp()) return;
    await loadMode();
    await loadAutoRun();
    createToolbar();
    refreshCards();
    if (!observerStarted) {
      observerStarted = true;
      const observer = new MutationObserver(() => refreshCards());
      observer.observe(getApp(), { childList: true, subtree: true });
      window.setInterval(() => {
        refreshCards();
        if (currentMode === 'auto-all' && autoRunEnabled && !isStarting && selected.size) kickoffAutoRunIfEnabled();
      }, 1500);
    }
    // Remove only the retired sequential state; do not stop the active profile-tab coordinator.
    await storageRemove();
    window.setTimeout(() => {
      const mode = document.querySelector('#rbu-mode');
      if (mode?.value === 'auto-all') {
        refreshCards();
        kickoffAutoRunIfEnabled();
      }
    }, 900);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'RBU_RUN_PROFILE') {
      const userId = String(message.userId || '');
      const item = message.item;
      const ownerToken = String(message.ownerToken || '');
      if (userId && ownerToken && item?.userId === userId && currentProfileId() === userId) {
        runParallelProfile(userId, item, ownerToken);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, reason: 'profile-id-mismatch' });
      }
      return true;
    }
    return false;
  });

  async function start() {
    if (isFriendsPage()) {
      let attempts = 0;
      const timer = window.setInterval(() => {
        attempts += 1;
        if (getApp()) {
          window.clearInterval(timer);
          startFriendsPage();
        } else if (attempts > 40) {
          window.clearInterval(timer);
        }
      }, 500);
      return;
    }

    // Profile tabs are started only by the parallel coordinator message.
    // Do not resume the retired sequential queue here.
    return;
  }

  start();
})();
