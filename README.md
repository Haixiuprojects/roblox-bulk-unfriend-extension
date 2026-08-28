# Roblox Bulk Unfriend Selector

A Chrome/Edge Manifest V3 extension for the Roblox Friends page. It detects the exact profile URL from each selected friend card and uses the official Roblox profile Unfriend action.

> **Created by Haixiuprojects — Filipino creator, Philippines.**

## Modes

| Mode | Behavior |
| --- | --- |
| **Normal — selected cards** | Select specific users yourself. Up to five profile tabs run at the same time; remaining users start as tabs close. |
| **Auto all — visible cards** | Automatically selects visible users and uses the profile-tab batch workflow. |

## Auto-run loop

In Auto all mode, enable the **Auto-run loop** checkbox and confirm it once. After that, you do not need to press the red button or manually uncheck cards. The setting remains enabled across page refreshes; the extension opens up to five profile tabs, clicks the official Unfriend control, automatically clears successful processed checks, waits for Roblox to update the Friends list, selects new visible cards, and starts the next batch.

Auto-run remains enabled when there are temporarily no new visible friends and waits for the Roblox list update. It does not automatically disable when a profile fails; it retries failed cards after a delay while the loop remains enabled. Only unchecking **Auto-run loop** or clicking **Stop batch** disables it. Failed cards remain checked so they can be reviewed.

## Workflow and routing

The queue is created from the currently checked friend cards. Each item has its own profile URL from the card link. The extension does not use a display-name or username gate; the selected card URL/user ID is the routing source, with a minimal URL routing guard to prevent a wrong profile tab from being processed.

A maximum of **5 profile tabs** run concurrently. After the Unfriend result, the profile tab closes automatically. The extension does not use a private Roblox API, password, access token, or hidden endpoint.

## Conflict protection

The coordinator has a maximum-five-tab limit, single-run lock, duplicate user-ID filtering, per-run owner token, owned-tab tracking, stale-job cleanup, legacy-job cleanup, and safe handling when a tab closes before the coordinator finishes. Expected `runtime.lastError` values are consumed in close/send callbacks so the Chrome Extensions Errors page does not fill with `No tab with id` warnings.

## Installation

Extract the ZIP file. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge, enable **Developer mode**, select **Load unpacked**, and choose the folder containing `manifest.json`. If an older version is already installed, click **Reload** and refresh the Roblox Friends page.

## Usage

Choose **Auto all — visible cards**, review the automatic checks, then enable **Auto-run loop**. The checkbox confirmation is the one-time confirmation; the first and subsequent batches then start automatically. Use **Stop batch** to stop and disable the persistent loop. In Normal mode, choose cards yourself and start the batch with the red button.

The corrected English package version is **v2.5.0**.
