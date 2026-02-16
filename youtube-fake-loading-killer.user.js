// ==UserScript==
// @name         「YouTubeの動画の再生が中断されています」という偽ロードをブロックするスクリプト
// @version      1.3.4
// @description  Blocks YouTube interruption toast/dialog, recovers playback, and logs diagnostics for blocker conflicts.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const PAGE_WINDOW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const PAGE_DOCUMENT = PAGE_WINDOW.document || document;
    const PAGE_LOCATION = PAGE_WINDOW.location || location;
    const STORAGE = (() => {
        try {
            return PAGE_WINDOW.localStorage || localStorage;
        } catch (_) {
            return null;
        }
    })();

    // Ignore iframe/about:blank contexts; only run on top YouTube watch documents.
    try {
        if (PAGE_WINDOW.top !== PAGE_WINDOW.self) return;
    } catch (_) {
        return;
    }
    if (PAGE_LOCATION.hostname !== 'www.youtube.com') return;

    const SCRIPT_VERSION = '1.3.4';
    const WATCH_PATH = '/watch';
    const SUPPORT_CODE = '3037019';

    const FLAG_KEYS = [
        'check_user_lact_at_prompt_shown_time_on_web',
        'enable_time_out_messages',
        'kevlar_autonav_popup_filtering'
    ];

    const DIALOG_SELECTORS = [
        'tp-yt-paper-toast',
        'yt-confirm-dialog-renderer',
        'ytd-enforcement-message-view-model',
        'tp-yt-paper-dialog[aria-modal="true"]',
        'tp-yt-paper-dialog[role="dialog"]',
        'ytd-popup-container tp-yt-paper-dialog'
    ].join(',');

    const DIALOG_TEXTS = [
        'experiencing interruptions',
        'playback interrupted',
        'was playback interrupted',
        '再生が中断',
        '播放中断',
        '播放已中断',
        '재생이 중단'
    ];

    const ACTION_TEXTS = [
        'continue',
        'resume',
        'yes',
        'ok',
        'watch',
        '続行',
        '再生',
        'はい',
        '继续',
        '繼續',
        '계속'
    ];

    const PLAYER_PATCH_MARK = '__interruptPatchInstalled';
    const HEALTH_CHECK_INTERVAL_MS = 1000;
    const STUCK_THRESHOLD_MS = 8000;
    const DEBUG_LOG_LIMIT = 400;
    const DEBUG_PREFIX = '[YT Interrupt Debug]';
    const NETWORK_PATCH_MARK = '__ytInterruptNetworkPatched';
    const RESOURCE_OBSERVER_MARK = '__ytInterruptResourceObserver';
    const VIDEO_DEBUG_MARK = 'ytInterruptDebugBound';
    const STORAGE_LOG_KEY = 'yt_interrupt_debug_logs';
    const STORAGE_INIT_KEY = 'yt_interrupt_last_init';
    const STORAGE_HEARTBEAT_KEY = 'yt_interrupt_last_heartbeat';

    const READY_STATE_TEXT = [
        'HAVE_NOTHING',
        'HAVE_METADATA',
        'HAVE_CURRENT_DATA',
        'HAVE_FUTURE_DATA',
        'HAVE_ENOUGH_DATA'
    ];

    const NETWORK_STATE_TEXT = [
        'NETWORK_EMPTY',
        'NETWORK_IDLE',
        'NETWORK_LOADING',
        'NETWORK_NO_SOURCE'
    ];

    const MEDIA_ERROR_TEXT = {
        1: 'MEDIA_ERR_ABORTED',
        2: 'MEDIA_ERR_NETWORK',
        3: 'MEDIA_ERR_DECODE',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED'
    };

    const DEBUG = (() => {
        try {
            if (!STORAGE) return true;
            return STORAGE.getItem('yt_interrupt_debug') !== '0';
        } catch (_) {
            return true;
        }
    })();

    const debugLogs = [];
    let debugInitDone = false;
    let storageWriteCounter = 0;

    const playbackHealth = {
        lastTime: -1,
        lastProgressAt: Date.now(),
        lastRecoveryAt: 0
    };

    function onWatchPage() {
        return (PAGE_LOCATION.pathname || '').startsWith(WATCH_PATH);
    }

    function lower(value) {
        return (value || '').toLowerCase();
    }

    function hasAnyText(text, needles) {
        const normalized = lower(text);
        return needles.some((needle) => normalized.includes(needle));
    }

    function shortText(value, max = 220) {
        const text = String(value || '');
        return text.length > max ? text.slice(0, max) + '...' : text;
    }

    function debug(type, payload) {
        if (!DEBUG) return;

        const entry = {
            at: new Date().toISOString(),
            type,
            payload: payload || {}
        };

        debugLogs.push(entry);
        if (debugLogs.length > DEBUG_LOG_LIMIT) {
            debugLogs.splice(0, debugLogs.length - DEBUG_LOG_LIMIT);
        }

        try {
            console.log(DEBUG_PREFIX, type, entry.payload);
        } catch (_) {
            // Ignore logging failures.
        }

        storageWriteCounter += 1;
        if (type === 'init' || storageWriteCounter % 5 === 0 || /error|blocked|recovery|stalled|waiting/.test(type)) {
            try {
                if (STORAGE) STORAGE.setItem(STORAGE_LOG_KEY, JSON.stringify(debugLogs));
            } catch (_) {
                // Ignore storage failures.
            }
        }
    }

    function attachDebugApiTo(target) {
        if (!target) return;
        try {
            target.__ytInterruptDebugLogs = debugLogs;
            target.__ytInterruptDump = () => debugLogs.slice();
            target.__ytInterruptDebugEnabled = DEBUG;
            target.ytInterruptDump = () => debugLogs.slice();
        } catch (_) {
            // Ignore target assignment failures.
        }
    }

    function installDebugApi() {
        if (debugInitDone) return;
        debugInitDone = true;

        attachDebugApiTo(globalThis);
        attachDebugApiTo(window);
        attachDebugApiTo(self);
        attachDebugApiTo(typeof unsafeWindow !== 'undefined' ? unsafeWindow : null);
        try {
            if (STORAGE) STORAGE.setItem(STORAGE_INIT_KEY, JSON.stringify({
                at: new Date().toISOString(),
                href: PAGE_LOCATION.href,
                version: SCRIPT_VERSION
            }));
        } catch (_) {
            // Ignore storage failures.
        }
        try {
            PAGE_DOCUMENT.documentElement.setAttribute('data-yt-interrupt-version', SCRIPT_VERSION);
        } catch (_) {
            // Ignore DOM marker failures.
        }

        debug('init', {
            href: PAGE_LOCATION.href,
            userAgent: shortText(navigator.userAgent, 140),
            debugEnabled: DEBUG,
            version: SCRIPT_VERSION
        });
    }

    function containsInterruptionMarker(value) {
        const text = lower(value);
        if (!text) return false;

        if (text.includes(SUPPORT_CODE)) return true;
        return DIALOG_TEXTS.some((needle) => text.includes(needle));
    }

    function payloadToText(payload) {
        if (!payload) return '';
        if (typeof payload === 'string') return payload;

        try {
            return JSON.stringify(payload);
        } catch (_) {
            return '';
        }
    }

    function keepLactFresh() {
        try {
            Object.defineProperty(window, '_lact', {
                configurable: true,
                get: () => Date.now(),
                set: () => true
            });
        } catch (_) {
            // Ignore if another script has already locked the property.
        }
    }

    function signalActivity() {
        try {
            const callback = window?.ytglobal?.ytUtilActivityCallback_;
            if (typeof callback === 'function') callback();
        } catch (_) {
            // Ignore.
        }

        try {
            document.dispatchEvent(new MouseEvent('mousemove', {
                bubbles: true,
                cancelable: true,
                clientX: 2,
                clientY: 2
            }));
        } catch (_) {
            // Ignore.
        }
    }

    function isInterestingRequest(url) {
        const text = lower(url);
        return text.includes('videoplayback') ||
            text.includes('initplayback') ||
            text.includes('/youtubei/v1/player') ||
            text.includes('googlevideo.com') ||
            text.includes('3037019') ||
            text.includes('check_ad_blockers');
    }

    function patchNetworkApis() {
        if (PAGE_WINDOW[NETWORK_PATCH_MARK]) return;

        const originalFetch = PAGE_WINDOW.fetch;
        if (typeof originalFetch === 'function') {
            PAGE_WINDOW.fetch = function patchedFetch(input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                const shouldLog = isInterestingRequest(url);
                const method = (init && init.method) || (input && input.method) || 'GET';

                if (shouldLog) {
                    debug('fetch_request', {
                        method,
                        url: shortText(url, 260)
                    });
                }

                return originalFetch.apply(this, arguments).then((response) => {
                    if (shouldLog) {
                        debug('fetch_response', {
                            method,
                            url: shortText(url, 260),
                            status: response.status,
                            ok: response.ok,
                            type: response.type
                        });
                    }
                    return response;
                }).catch((error) => {
                    if (shouldLog) {
                        debug('fetch_error', {
                            method,
                            url: shortText(url, 260),
                            error: shortText(error && error.message ? error.message : String(error))
                        });
                    }
                    throw error;
                });
            };
        }

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function patchedXhrOpen(method, url) {
            this.__ytInterruptXhrInfo = {
                method: method || 'GET',
                url: String(url || '')
            };
            return originalOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function patchedXhrSend() {
            const info = this.__ytInterruptXhrInfo || { method: 'GET', url: '' };
            const shouldLog = isInterestingRequest(info.url);

            if (shouldLog) {
                debug('xhr_request', {
                    method: info.method,
                    url: shortText(info.url, 260)
                });
            }

            this.addEventListener('loadend', () => {
                if (!shouldLog) return;
                debug('xhr_response', {
                    method: info.method,
                    url: shortText(info.url, 260),
                    status: this.status
                });
            }, { once: true });

            this.addEventListener('error', () => {
                if (!shouldLog) return;
                debug('xhr_error', {
                    method: info.method,
                    url: shortText(info.url, 260)
                });
            }, { once: true });

            return originalSend.apply(this, arguments);
        };

        Object.defineProperty(PAGE_WINDOW, NETWORK_PATCH_MARK, {
            configurable: true,
            value: true
        });
    }

    function installResourceObserver() {
        if (!DEBUG || PAGE_WINDOW[RESOURCE_OBSERVER_MARK] || typeof PAGE_WINDOW.PerformanceObserver !== 'function') return;

        try {
            const observer = new PAGE_WINDOW.PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (!isInterestingRequest(entry.name)) continue;
                    debug('resource', {
                        name: shortText(entry.name, 260),
                        initiatorType: entry.initiatorType,
                        duration: Math.round(entry.duration),
                        transferSize: entry.transferSize,
                        encodedBodySize: entry.encodedBodySize
                    });
                }
            });

            observer.observe({ type: 'resource', buffered: true });
            Object.defineProperty(PAGE_WINDOW, RESOURCE_OBSERVER_MARK, {
                configurable: true,
                value: true
            });
        } catch (error) {
            debug('resource_observer_error', {
                error: shortText(error && error.message ? error.message : String(error))
            });
        }
    }

    function bindVideoDebugEvents(video) {
        if (!video || video[VIDEO_DEBUG_MARK]) return;

        const events = [
            'loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause',
            'waiting', 'stalled', 'suspend', 'seeking', 'seeked',
            'progress', 'error', 'abort', 'emptied', 'ended'
        ];

        const snapshot = () => ({
            currentTime: Number(video.currentTime || 0).toFixed(3),
            paused: !!video.paused,
            readyState: READY_STATE_TEXT[video.readyState] || video.readyState,
            networkState: NETWORK_STATE_TEXT[video.networkState] || video.networkState,
            src: shortText(video.currentSrc || '', 180),
            error: video.error ? (MEDIA_ERROR_TEXT[video.error.code] || video.error.code) : null
        });

        for (const eventName of events) {
            video.addEventListener(eventName, () => {
                if (eventName === 'progress') return;
                debug('video_' + eventName, snapshot());
            }, true);
        }

        Object.defineProperty(video, VIDEO_DEBUG_MARK, {
            configurable: true,
            value: true
        });
    }

    function disableFlags(flags) {
        if (!flags || typeof flags !== 'object') return;
        const changed = [];

        for (const key of FLAG_KEYS) {
            if (Object.prototype.hasOwnProperty.call(flags, key)) {
                if (flags[key] !== false) {
                    changed.push(key);
                }
                flags[key] = false;
            }
        }

        if (changed.length) {
            debug('flags_disabled', { keys: changed });
        }
    }

    function patchYtConfig() {
        const ytcfg = window.ytcfg;
        if (!ytcfg || typeof ytcfg !== 'object') return;

        const data = ytcfg.data_ || (typeof ytcfg.d === 'function' ? ytcfg.d() : null);
        if (data && typeof data === 'object') {
            disableFlags(data.EXPERIMENT_FLAGS);
            disableFlags(data.EXPERIMENTS_FORCED_FLAGS);
        }

        if (ytcfg.__interruptPatchInstalled || typeof ytcfg.set !== 'function') return;

        const originalSet = ytcfg.set;
        ytcfg.set = function patchedSet(key, value) {
            if (key && typeof key === 'object') {
                disableFlags(key.EXPERIMENT_FLAGS);
                disableFlags(key.EXPERIMENTS_FORCED_FLAGS);
            } else if (typeof key === 'string' && value && typeof value === 'object') {
                if (key === 'EXPERIMENT_FLAGS' || key === 'EXPERIMENTS_FORCED_FLAGS') {
                    disableFlags(value);
                }
            }
            return originalSet.apply(this, arguments);
        };

        Object.defineProperty(ytcfg, '__interruptPatchInstalled', {
            configurable: true,
            value: true
        });
    }

    function findPlayer() {
        return PAGE_DOCUMENT.querySelector('#movie_player');
    }

    function patchPlayerApi() {
        const player = findPlayer();
        if (!player || player[PLAYER_PATCH_MARK]) return;

        if (typeof player.LR === 'function') {
            const originalLR = player.LR;
            player.LR = function patchedLR(eventName, payload) {
                if ((eventName === 'onSnackbarMessage' && (payload === 1 || payload === '1')) ||
                    (eventName === 'innertubeCommand' && containsInterruptionMarker(payloadToText(payload)))) {
                    debug('player_event_blocked', {
                        eventName,
                        payload: shortText(payloadToText(payload), 280)
                    });
                    return;
                }
                return originalLR.apply(this, arguments);
            };
        }

        if (typeof player.pauseVideo === 'function') {
            const originalPause = player.pauseVideo;
            player.pauseVideo = function patchedPauseVideo() {
                if (hasInterruptionUi()) {
                    debug('pause_blocked', { reason: 'interruption_ui_detected' });
                    return;
                }
                return originalPause.apply(this, arguments);
            };
        }

        Object.defineProperty(player, PLAYER_PATCH_MARK, {
            configurable: true,
            value: true
        });
    }

    function findActionButton(dialog) {
        const candidates = dialog.querySelectorAll('button, [role="button"], yt-button-renderer, tp-yt-paper-button');

        for (const candidate of candidates) {
            const label = [
                candidate.textContent,
                candidate.getAttribute && candidate.getAttribute('aria-label'),
                candidate.getAttribute && candidate.getAttribute('title')
            ].join(' ');

            if (hasAnyText(label, ACTION_TEXTS)) {
                return candidate;
            }
        }

        return null;
    }

    function removeBySupportLink() {
        const links = PAGE_DOCUMENT.querySelectorAll('a[href*="3037019"], a[href*="check_ad_blockers"]');
        for (const link of links) {
            const host = link.closest('tp-yt-paper-toast, yt-confirm-dialog-renderer, tp-yt-paper-dialog, ytd-popup-container');
            if (host && host.isConnected) {
                debug('dialog_removed_by_link', {
                    href: shortText(link.getAttribute('href') || '')
                });
                host.remove();
            }
        }
    }

    function hasInterruptionUi() {
        const dialogs = PAGE_DOCUMENT.querySelectorAll(DIALOG_SELECTORS);
        for (const dialog of dialogs) {
            const text = [
                dialog.textContent,
                dialog.getAttribute && dialog.getAttribute('aria-label')
            ].join(' ');

            if (containsInterruptionMarker(text)) {
                return true;
            }

            const hasSupportLink = dialog.querySelector?.('a[href*="3037019"], a[href*="check_ad_blockers"]');
            if (hasSupportLink) {
                return true;
            }
        }
        return false;
    }

    function clearInterruptDialogs() {
        let handled = false;
        const dialogs = PAGE_DOCUMENT.querySelectorAll(DIALOG_SELECTORS);

        for (const dialog of dialogs) {
            const text = [
                dialog.textContent,
                dialog.getAttribute && dialog.getAttribute('aria-label')
            ].join(' ');

            const hasSupportLink = !!dialog.querySelector?.('a[href*="3037019"], a[href*="check_ad_blockers"]');
            const interruptionTextMatched = containsInterruptionMarker(text);
            if (!hasSupportLink && !interruptionTextMatched) {
                continue;
            }

            const button = findActionButton(dialog);
            if (button && typeof button.click === 'function') {
                button.click();
                debug('dialog_action_clicked', {
                    text: shortText(text, 200)
                });
                handled = true;
            } else {
                if (dialog.isConnected) {
                    dialog.remove();
                    debug('dialog_removed', {
                        text: shortText(text, 200)
                    });
                }
                handled = true;
            }
        }

        removeBySupportLink();
        return handled;
    }

    function ensurePlayback() {
        const video = PAGE_DOCUMENT.querySelector('video');
        if (!video) return;

        bindVideoDebugEvents(video);

        if (video.paused && video.readyState >= 2) {
            debug('ensure_playback', {
                currentTime: Number(video.currentTime || 0).toFixed(3),
                readyState: READY_STATE_TEXT[video.readyState] || video.readyState
            });
            video.play().catch(() => {});
        }
    }

    function recoverStuckPlayback() {
        if (!onWatchPage()) return;

        const video = PAGE_DOCUMENT.querySelector('video');
        if (!video || video.ended) return;
        bindVideoDebugEvents(video);

        const now = Date.now();
        const current = Number(video.currentTime || 0);
        const progressed = Math.abs(current - playbackHealth.lastTime) > 0.02;

        if (progressed) {
            playbackHealth.lastTime = current;
            playbackHealth.lastProgressAt = now;
            return;
        }

        const player = findPlayer();
        const playerState = typeof player?.getPlayerState === 'function' ? player.getPlayerState() : -1;
        const buffering = playerState === 3 || !!PAGE_DOCUMENT.querySelector('.ytp-spinner');
        const interruptionUi = hasInterruptionUi();
        const likelyBlocked = interruptionUi || (buffering && video.readyState <= 1);

        if (!likelyBlocked || (now - playbackHealth.lastProgressAt < STUCK_THRESHOLD_MS)) {
            return;
        }

        if (now - playbackHealth.lastRecoveryAt < STUCK_THRESHOLD_MS) {
            return;
        }
        playbackHealth.lastRecoveryAt = now;

        debug('recovery_attempt', {
            currentTime: Number(current).toFixed(3),
            readyState: READY_STATE_TEXT[video.readyState] || video.readyState,
            networkState: NETWORK_STATE_TEXT[video.networkState] || video.networkState,
            playerState,
            hasInterruptionUi: interruptionUi
        });

        keepLactFresh();
        signalActivity();
        clearInterruptDialogs();

        if (typeof player?.playVideo === 'function') {
            try {
                player.playVideo();
            } catch (_) {
                // Ignore.
            }
        }

        if (video.paused) {
            video.play().catch(() => {});
        }

        if (video.readyState >= 2 && current < 0.05) {
            try {
                video.currentTime = 0.05;
            } catch (_) {
                // Ignore.
            }
        }

        if (typeof player?.seekTo === 'function' && video.readyState >= 2 && current < 0.1) {
            try {
                player.seekTo(0.05, true);
            } catch (_) {
                // Ignore.
            }
        }
    }

    function run() {
        if (!onWatchPage()) return;

        installDebugApi();
        patchNetworkApis();
        installResourceObserver();
        try {
            if (STORAGE) STORAGE.setItem(STORAGE_HEARTBEAT_KEY, JSON.stringify({
                at: new Date().toISOString(),
                href: PAGE_LOCATION.href,
                version: SCRIPT_VERSION
            }));
        } catch (_) {
            // Ignore storage failures.
        }

        keepLactFresh();
        signalActivity();
        patchYtConfig();
        patchPlayerApi();

        if (clearInterruptDialogs()) {
            ensurePlayback();
        }

        recoverStuckPlayback();
    }

    const observer = new MutationObserver(() => {
        if (!onWatchPage()) return;

        patchPlayerApi();
        if (clearInterruptDialogs()) {
            ensurePlayback();
        }
    });

    function startObserver() {
        if (!PAGE_DOCUMENT.body) {
            requestAnimationFrame(startObserver);
            return;
        }

        observer.observe(PAGE_DOCUMENT.body, { childList: true, subtree: true });
    }

    document.addEventListener('yt-navigate-finish', run, true);
    document.addEventListener('yt-page-data-updated', run, true);

    installDebugApi();
    setInterval(run, HEALTH_CHECK_INTERVAL_MS);
    startObserver();
    run();
})();
