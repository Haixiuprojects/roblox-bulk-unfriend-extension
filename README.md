# Roblox Bulk Unfriend Selector

Chrome/Edge Manifest V3 extension para sa Roblox Friends page. Awtomatikong kinukuha nito ang exact profile URL mula sa bawat selected friend card at ginagamit iyon para sa official Roblox profile Unfriend action.

## Modes

| Mode | Gawi |
| --- | --- |
| **Normal — selected cards** | Ikaw ang magche-check ng specific users. Maximum limang profile tabs ang sabay-sabay; kapag may tab nang nagsara, susunod ang natitirang selected users. |
| **Auto all — visible cards** | Awtomatikong iche-check ang visible users at gagamitin ang profile-tab batch workflow. |

## Auto-run loop

Sa Auto all mode, i-enable ang checkbox na **Auto-run loop** at kumpirmahin ito nang isang beses. Pagkatapos noon, hindi mo na kailangang pindutin ang red button o mano-manong mag-uncheck. Ang setting ay persistent kahit mag-refresh ang page; ang extension ay magbubukas ng maximum limang profile tabs, magki-click ng official Unfriend control, awtomatikong magki-clear ng successful processed checks, maghihintay sa Roblox sariling list update, magse-select ng bagong visible cards, at sisimulan ang susunod na batch.

Mananatiling enabled ang Auto-run kapag pansamantalang walang bagong visible friends at maghihintay ito sa Roblox list update. Hindi ito kusang nagdi-disable kapag may failed profile; ire-retry nito ang failed cards pagkatapos ng delay habang naka-enable pa rin ang loop. Tanging pag-uncheck ng **Auto-run loop** o pag-click sa **Stop batch** ang magdi-disable nito. Mananatiling naka-check ang failed cards para makita ang problema.

## Workflow and routing

Ang queue ay ginagawa mula sa kasalukuyang checked friend cards. Bawat item ay may sariling profile URL mula sa card link. Ang extension ay hindi gumagamit ng display-name o username gate; selected card URL/user ID ang routing source at may minimal URL routing guard lamang upang hindi ma-process ang maling profile tab.

Maximum **5 profile tabs** lamang ang sabay-sabay. Pagkatapos ng Unfriend result, awtomatikong isinasara ang profile tab. Hindi gumagamit ang extension ng private Roblox API, password, access token, o hidden endpoint.

## Conflict protection

May maximum-five-tab coordinator, single-run lock, duplicate user-ID filtering, per-run owner token, tracked owned tabs, stale-job cleanup, legacy-job cleanup, at safe handling kapag nauna nang nagsara ang tab. Kinokonsumo nito ang expected `runtime.lastError` sa close/send callbacks upang hindi mapuno ang Chrome extension Errors page ng `No tab with id` warnings. Hindi dapat maghalo ang lumang queue sa bagong queue o magsara ng tab na hindi pagmamay-ari ng extension.

## Installation

I-extract ang ZIP file. Buksan ang `chrome://extensions` sa Chrome o `edge://extensions` sa Edge, i-on ang **Developer mode**, piliin ang **Load unpacked**, at piliin ang folder na naglalaman ng `manifest.json`. Kung naka-install na ang lumang version, pindutin ang **Reload** at i-refresh ang Roblox Friends page.

## Usage

Piliin ang **Auto all — visible cards**, i-review ang automatic checks, pagkatapos i-enable ang **Auto-run loop**. Ang checkbox confirmation ang one-time confirmation para sa loop; pagkatapos nito ay automatic na ang unang at susunod na batches. Gamitin ang **Stop batch** kung gusto mong ihinto at i-disable ang persistent loop. Sa Normal mode, ikaw ang pipili ng cards at kailangan mong simulan ang batch gamit ang red button.

Ang corrected package version ay **v2.4.1**.
