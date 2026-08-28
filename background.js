const STORAGE_KEY = 'rbuParallelJobV3';
const LEGACY_STORAGE_KEYS = ['rbuParallelJobV1', 'rbuParallelJobV2'];
const RESULT_MESSAGE = 'RBU_PROFILE_RESULT';
const START_MESSAGE = 'RBU_START_PARALLEL';
const MAX_CONCURRENT_TABS = 5;
const TAB_TIMEOUT_MS = 30000;
const STALE_JOB_MS = 20 * 60 * 1000;
const FRIENDS_URL = 'https://www.roblox.com/users/friends#!/friends';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let startLock = false;
let jobMutation = Promise.resolve();

function getJob() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => resolve(result[STORAGE_KEY] || null));
  });
}

function setJob(job) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: job }, resolve);
  });
}

function removeJob() {
  return new Promise((resolve) => chrome.storage.local.remove(STORAGE_KEY, resolve));
}

function withJobLock(task) {
  const next = jobMutation.then(task, task);
  jobMutation = next.catch(() => undefined);
  return next;
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        reject(new Error(chrome.runtime.lastError?.message || 'Could not create tab'));
        return;
      }
      resolve(tab);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab));
  });
}

function removeTab(tabId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve();
      return;
    }
    chrome.tabs.remove(tabId, () => {
      // Consume expected "No tab with id" errors when a tab already auto-closed.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      const error = chrome.runtime.lastError;
      resolve(!error);
    });
  });
}

function isProfileUrl(url, userId) {
  return new RegExp(`^https://www\\.roblox\\.com/users/${userId}/profile(?:[?#].*)?$`, 'i').test(url || '');
}

function makeOwnerToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeItems(items) {
  const seen = new Set();
  return items
    .map((item) => ({
      userId: String(item?.userId || ''),
      displayName: String(item?.displayName || '').trim(),
      username: String(item?.username || '').trim(),
      profileUrl: String(item?.profileUrl || '').trim(),
    }))
    .filter((item) => {
      if (!/^\d+$/.test(item.userId)) return false;
      if (!isProfileUrl(item.profileUrl, item.userId)) return false;
      if (seen.has(item.userId)) return false;
      seen.add(item.userId);
      return true;
    });
}

async function clearLegacyState() {
  const result = await new Promise((resolve) => chrome.storage.local.get(LEGACY_STORAGE_KEYS, resolve));
  const tabIds = [];
  for (const key of LEGACY_STORAGE_KEYS) {
    const legacy = result?.[key];
    Object.keys(legacy?.tabs || {}).forEach((id) => {
      const tabId = Number(id);
      if (Number.isInteger(tabId)) tabIds.push(tabId);
    });
  }
  await Promise.all([...new Set(tabIds)].map(removeTab));
  await new Promise((resolve) => chrome.storage.local.remove(LEGACY_STORAGE_KEYS, resolve));
}

async function clearStaleJobIfNeeded(job) {
  if (!job?.active) return job;
  const started = Date.parse(job.startedAt || '');
  if (Number.isFinite(started) && Date.now() - started < STALE_JOB_MS) return job;
  job.active = false;
  job.phase = 'stale';
  job.stopped = true;
  job.finishedAt = new Date().toISOString();
  await setJob(job);
  const tabIds = Object.keys(job.tabs || {}).map(Number).filter(Number.isInteger);
  await Promise.all(tabIds.map(removeTab));
  await removeJob();
  return null;
}

async function returnOriginToFriends(job) {
  // Roblox updates the Friends list itself after a successful Unfriend.
  // Do not reload or navigate the origin tab; this avoids tab/page races.
  return job;
}

async function finishParallelJob(job) {
  if (!job || !job.active) return;
  job.active = false;
  job.phase = 'finished';
  job.finishedAt = new Date().toISOString();
  job.processed = job.done + job.failed.length;
  job.tabs = {};
  await setJob(job);
  await returnOriginToFriends(job);
}

function canFinish(job) {
  return job.nextIndex >= job.items.length
    && Object.keys(job.tabs || {}).length === 0
    && job.processed >= job.items.length;
}

async function fillTabs(ownerToken) {
  await withJobLock(async () => {
    let job = await getJob();
    if (!job?.active || job.ownerToken !== ownerToken) return;

    while (Object.keys(job.tabs || {}).length < MAX_CONCURRENT_TABS && job.nextIndex < job.items.length) {
      const item = job.items[job.nextIndex];
      job.nextIndex += 1;
      await setJob(job);

      try {
        const tab = await createTab(item.profileUrl);
        const current = await getJob();
        if (!current?.active || current.ownerToken !== ownerToken) {
          await removeTab(tab.id);
          return;
        }
        current.tabs[String(tab.id)] = {
          item,
          ownerToken,
          openedAt: Date.now(),
          result: null,
        };
        current.phase = 'running';
        await setJob(current);
        job = current;
        waitForProfileLoad(tab.id, item, ownerToken).then((ready) => {
          if (!ready) markTabTimeout(tab.id, ownerToken);
        });
      } catch (error) {
        const current = await getJob();
        if (!current?.active || current.ownerToken !== ownerToken) return;
        current.failed.push({ ...item, reason: error.message || 'tab-open-failed' });
        current.processed = current.done + current.failed.length;
        await setJob(current);
        job = current;
      }
    }

    const completed = await getJob();
    if (completed?.active && completed.ownerToken === ownerToken && canFinish(completed)) {
      await finishParallelJob(completed);
    } else if (completed?.active && completed.ownerToken === ownerToken) {
      completed.phase = 'running';
      await setJob(completed);
    }
  });
}

async function waitForProfileLoad(tabId, item, ownerToken, tries = Math.ceil(TAB_TIMEOUT_MS / 500)) {
  for (let i = 0; i < tries; i += 1) {
    const tab = await getTab(tabId);
    if (!tab) return false;
    if (isProfileUrl(tab.url, item.userId)) {
      const current = await getJob();
      const state = current?.tabs?.[String(tabId)];
      if (!current?.active || current.ownerToken !== ownerToken || !state) return false;
      const sent = await sendToTab(tabId, {
        type: 'RBU_RUN_PROFILE',
        userId: item.userId,
        item,
        ownerToken,
      });
      if (sent) return true;
    }
    await sleep(500);
  }
  return false;
}

async function finalizeTab(tabId, ownerToken) {
  await sleep(400);
  await removeTab(tabId);
  let shouldFill = false;
  await withJobLock(async () => {
    const job = await getJob();
    if (!job?.active || job.ownerToken !== ownerToken || !job.tabs?.[String(tabId)]) return;
    delete job.tabs[String(tabId)];
    job.processed = job.done + job.failed.length;
    if (canFinish(job)) await finishParallelJob(job);
    else {
      await setJob(job);
      shouldFill = true;
    }
  });
  if (shouldFill) await fillTabs(ownerToken);
}

async function handleTabResult(tabId, result, ownerToken) {
  let accepted = false;
  await withJobLock(async () => {
    const job = await getJob();
    if (!job?.active || job.ownerToken !== ownerToken || !job.tabs?.[String(tabId)]) return;
    const state = job.tabs[String(tabId)];
    if (state.result) return;
    state.result = result?.ok ? 'success' : 'failed';
    state.reason = result?.reason || '';
    if (result?.ok) job.done += 1;
    else job.failed.push({ ...state.item, reason: result?.reason || 'unknown' });
    job.processed = job.done + job.failed.length;
    await setJob(job);
    accepted = true;
  });
  if (accepted) await finalizeTab(tabId, ownerToken);
}

async function markTabTimeout(tabId, ownerToken) {
  const job = await getJob();
  const state = job?.tabs?.[String(tabId)];
  if (!job?.active || !state || state.ownerToken !== ownerToken || state.result) return;
  await handleTabResult(tabId, { ok: false, reason: 'profile-timeout-or-extension-not-ready' }, ownerToken);
}

async function startParallelJob(items, delay, originTabId, autoRefresh) {
  const ownerToken = makeOwnerToken();
  const job = {
    version: 3,
    mode: 'parallel-tabs',
    active: true,
    phase: 'opening',
    ownerToken,
    originTabId: Number.isInteger(originTabId) ? originTabId : null,
    autoRefresh: Boolean(autoRefresh),
    items,
    nextIndex: 0,
    tabs: {},
    done: 0,
    failed: [],
    processed: 0,
    delay: Math.max(800, Number(delay) || 1200),
    startedAt: new Date().toISOString(),
  };
  await setJob(job);
  await fillTabs(ownerToken);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === START_MESSAGE) {
    if (startLock) {
      sendResponse({ ok: false, reason: 'parallel-start-already-in-progress' });
      return true;
    }
    startLock = true;
    (async () => {
      try {
        await clearLegacyState();
        let existing = await getJob();
        existing = await clearStaleJobIfNeeded(existing);
        if (existing?.active) {
          sendResponse({ ok: false, reason: 'parallel-job-already-running' });
          return;
        }
        const items = normalizeItems(Array.isArray(message.items) ? message.items : []);
        if (!items.length) {
          sendResponse({ ok: false, reason: 'no-valid-items' });
          return;
        }
        sendResponse({ ok: true, accepted: items.length, concurrent: MAX_CONCURRENT_TABS });
        await startParallelJob(items, message.delay, sender.tab?.id, message.autoRefresh);
      } catch (error) {
        sendResponse({ ok: false, reason: error.message || 'parallel-start-failed' });
      } finally {
        startLock = false;
      }
    })();
    return true;
  }

  if (message?.type === RESULT_MESSAGE) {
    const tabId = sender.tab?.id;
    const ownerToken = String(message.ownerToken || '');
    if (Number.isInteger(tabId) && ownerToken) handleTabResult(tabId, message.result, ownerToken);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'RBU_GET_PARALLEL_JOB') {
    getJob().then((job) => sendResponse({ ok: true, job }));
    return true;
  }

  if (message?.type === 'RBU_STOP_PARALLEL') {
    withJobLock(async () => {
      const job = await getJob();
      if (!job?.active) {
        sendResponse({ ok: true });
        return;
      }
      job.active = false;
      job.phase = 'stopped';
      job.stopped = true;
      job.finishedAt = new Date().toISOString();
      job.processed = job.done + job.failed.length;
      await setJob(job);
      await Promise.all(Object.keys(job.tabs || {}).map(Number).filter(Number.isInteger).map(removeTab));
      job.tabs = {};
      await setJob(job);
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  getJob().then((job) => {
    if (!job?.active || !job.tabs?.[String(tabId)]) return;
    const state = job.tabs[String(tabId)];
    sendToTab(tabId, {
      type: 'RBU_RUN_PROFILE',
      userId: state.item.userId,
      item: state.item,
      ownerToken: state.ownerToken,
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getJob().then(async (job) => {
    const state = job?.tabs?.[String(tabId)];
    if (!job?.active || !state || state.result) return;
    await handleTabResult(tabId, { ok: false, reason: 'tab-closed-before-result' }, state.ownerToken);
  });
});
