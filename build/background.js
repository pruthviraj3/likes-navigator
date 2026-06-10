(() => {
    const CACHE_STORAGE_KEY = "instaLikedCache";
    const MONTH_RESULTS_STORAGE_KEY = "instaLikedMonthResults";
    const DB_NAME = "instaLikedNavigator";
    const DB_VERSION = 2;
    const APP_STATE_STORE = "appState";
    const IMAGE_STORE = "imageBlobs";
    const APP_STATE_KEYS = {
        cache: CACHE_STORAGE_KEY,
        monthResults: MONTH_RESULTS_STORAGE_KEY
    };
    let dbPromise = null;
    chrome.runtime.onInstalled.addListener(async () => {
        await initializeStorage();
    });
    void initializeStorage().catch(() => null);
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message !== "object") {
            return false;
        }
        if (message.type === "LIKED_ITEMS_CAPTURED") {
            mergeCapturedItems(message.payload)
                .then((summary) => sendResponse({ ok: true, summary }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_CACHE_SUMMARY") {
            getCacheSummary()
                .then((summary) => sendResponse({ ok: true, summary }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_APP_STATE") {
            getAppState()
                .then((state) => sendResponse({ ok: true, state }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_RESULT_SUMMARIES") {
            getResultSummaries(Array.isArray(message.keys) ? message.keys : [])
                .then((summariesByKey) => sendResponse({ ok: true, summariesByKey }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_RESULT_DETAILS") {
            getResultDetails(String(message.key || ""))
                .then((result) => sendResponse({ ok: true, result }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_MONTH_RESULTS") {
            getMonthResults(Number(message.year), Number(message.month))
                .then((results) => sendResponse({ ok: true, results }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_YEAR_MONTH_COUNTS") {
            getYearMonthCounts(Number(message.year))
                .then((countsByMonth) => sendResponse({ ok: true, countsByMonth }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "SAVE_EXTRACTION_RESULT") {
            saveExtractionResult(message.result)
                .then((payload) => sendResponse({ ok: true, payload }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "PREPARE_FETCHED_DATA_EXPORT") {
            prepareFetchedDataExport()
                .then((payload) => sendResponse({ ok: true, ...payload }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_EXPORT_IMAGE_BATCH") {
            getExportImageBatch(Number(message.offset || 0), Number(message.limit || 10))
                .then((payload) => sendResponse({ ok: true, ...payload }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        if (message.type === "GET_MEDIA_FOR_IMAGE_KEY") {
            readCache().then((cache) => {
                const mediaId = cache.imageKeyToMediaId[message.imageKey];
                sendResponse({
                    ok: true,
                    item: mediaId ? cache.itemsByMediaId[mediaId] || null : null
                });
            });
            return true;
        }
        if (message.type === "GET_MEDIA_FOR_IMAGE_KEYS") {
            readCache().then((cache) => {
                const itemsByImageKey = {};
                for (const imageKey of Array.isArray(message.imageKeys) ? message.imageKeys : []) {
                    const mediaId = cache.imageKeyToMediaId[imageKey];
                    const item = mediaId ? cache.itemsByMediaId[mediaId] || null : null;
                    if (item) {
                        itemsByImageKey[imageKey] = item;
                    }
                }
                sendResponse({
                    ok: true,
                    itemsByImageKey
                });
            });
            return true;
        }
        if (message.type === "DEBUG_EVENT") {
            appendDebugEvent(message.payload)
                .then(() => sendResponse({ ok: true }))
                .catch((error) => sendResponse({ ok: false, error: String(error) }));
            return true;
        }
        return false;
    });
    async function getAppState() {
        const [cacheSummary, monthState, extractorStatus] = await Promise.all([
            getCacheSummary(),
            getMonthResultsState(),
            getExtractorStatusForActiveTab()
        ]);
        const latestMonthResult = monthState.latestKey
            ? {
                key: monthState.latestKey,
                ...summarizeResult(monthState.resultsByKey[monthState.latestKey] || null)
            }
            : null;
        return {
            cacheSummary,
            extractorStatus,
            latestMonthResult
        };
    }
    async function getCacheSummary() {
        const cache = await readCache();
        return {
            itemCount: Object.keys(cache.itemsByMediaId).length,
            imageKeyCount: Object.keys(cache.imageKeyToMediaId).length,
            lastUpdatedAt: cache.lastUpdatedAt,
            recentRequests: cache.recentRequests,
            debugEvents: cache.debugEvents
        };
    }
    async function getMonthResultsState() {
        const state = await readState(APP_STATE_KEYS.monthResults);
        return normalizeMonthResultsState(state);
    }
    async function getResultSummaries(keys) {
        const state = await getMonthResultsState();
        const summariesByKey = {};
        for (const key of keys) {
            const result = state.resultsByKey[key];
            if (!result) {
                continue;
            }
            summariesByKey[key] = {
                key,
                ...summarizeResult(result)
            };
        }
        return summariesByKey;
    }
    async function getResultDetails(key) {
        const state = await getMonthResultsState();
        return state.resultsByKey[key] || null;
    }
    async function getMonthResults(year, month) {
        const normalizedYear = Number(year);
        const normalizedMonth = Number(month);
        if (!Number.isFinite(normalizedYear) || !Number.isFinite(normalizedMonth)) {
            return [];
        }
        const state = await getMonthResultsState();
        return Object.values((state.resultsByKey || {}))
            .filter((result) => {
            return Number(result?.year) === normalizedYear && Number(result?.month) === normalizedMonth;
        })
            .sort((left, right) => {
            const leftDate = String(left?.start_date || "");
            const rightDate = String(right?.start_date || "");
            return leftDate.localeCompare(rightDate);
        });
    }
    async function getYearMonthCounts(year) {
        const normalizedYear = Number(year);
        if (!Number.isFinite(normalizedYear)) {
            return {};
        }
        const state = await getMonthResultsState();
        const countsByMonth = {};
        for (const result of Object.values((state.resultsByKey || {}))) {
            const resultYear = Number(result?.year);
            const resultMonth = Number(result?.month);
            if (!Number.isFinite(resultYear) || !Number.isFinite(resultMonth) || resultYear !== normalizedYear) {
                continue;
            }
            countsByMonth[resultMonth] = Number(countsByMonth[resultMonth] || 0) + Number(result?.count || 0);
        }
        return countsByMonth;
    }
    async function getExtractorStatusForActiveTab() {
        const tab = await getActiveInstagramTab();
        if (!tab?.id) {
            return {
                available: false,
                ready: false,
                reason: "Open an instagram.com tab to use the extractor."
            };
        }
        try {
            const response = await chrome.tabs.sendMessage(tab.id, {
                type: "GET_EXTRACTOR_STATUS"
            });
            if (!response?.ok) {
                return {
                    available: false,
                    ready: false,
                    reason: response?.error || "The Instagram tab did not respond."
                };
            }
            return {
                available: true,
                ...response.payload
            };
        }
        catch (_error) {
            return {
                available: false,
                ready: false,
                reason: "Reload the Instagram tab so the extension content script is active."
            };
        }
    }
    async function saveExtractionResult(result) {
        const savedResult = await saveMonthResult(result);
        await mergeMonthResultIntoCache(savedResult);
        const imageStorage = await storeResultImages(savedResult);
        return {
            result: savedResult,
            summary: {
                key: getResultStorageKey(savedResult),
                count: savedResult.count,
                extractedAt: savedResult.extracted_at
            },
            imageStorage
        };
    }
    async function prepareFetchedDataExport() {
        const [cache, monthState, imageCount] = await Promise.all([
            readCache(),
            getMonthResultsState(),
            countImageBlobs()
        ]);
        return {
            filename: buildExportFilename(),
            exportData: {
                source: "instagram_liked_posts_extension",
                exportedAt: new Date().toISOString(),
                summary: {
                    resultCount: Object.keys(monthState.resultsByKey || {}).length,
                    postCount: Object.keys(cache.itemsByMediaId || {}).length,
                    imageCount
                },
                cache,
                fetchedResults: monthState
            },
            imageCount
        };
    }
    async function getExportImageBatch(offset, limit) {
        const normalizedOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
        const normalizedLimit = Math.min(25, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 10));
        const records = await readImageBlobPage(normalizedOffset, normalizedLimit);
        const images = [];
        for (const record of records) {
            const blob = record?.blob;
            if (!(blob instanceof Blob)) {
                continue;
            }
            images.push({
                mediaId: String(record.mediaId || ""),
                resultKey: String(record.resultKey || ""),
                sourceUrl: String(record.sourceUrl || ""),
                contentType: String(record.contentType || blob.type || "application/octet-stream"),
                size: Number(record.size || blob.size || 0),
                savedAt: String(record.savedAt || ""),
                dataBase64: await blobToBase64(blob)
            });
        }
        return {
            offset: normalizedOffset,
            nextOffset: normalizedOffset + records.length,
            done: records.length < normalizedLimit,
            images
        };
    }
    function buildExportFilename() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        return `instagram-liked-posts-export-${timestamp}.json`;
    }
    async function saveMonthResult(result) {
        const state = await getMonthResultsState();
        const key = getResultStorageKey(result);
        const normalized = {
            source: "instagram_activity_center_likes",
            year: Number(result.year),
            month: Number(result.month),
            label: String(result.label || "month"),
            start_date: result.start_date ? String(result.start_date) : null,
            end_date: result.end_date ? String(result.end_date) : null,
            sort: result.sort === "newest_to_oldest" ? "newest_to_oldest" : "oldest_to_newest",
            time_zone: String(result.time_zone || "UTC"),
            request_date_range: result.request_date_range || null,
            pagination_debug: Array.isArray(result.pagination_debug) ? result.pagination_debug : [],
            extracted_at: String(result.extracted_at || new Date().toISOString()),
            page_count: Number(result.page_count || 0),
            count: Array.isArray(result.items) ? result.items.length : 0,
            items: Array.isArray(result.items) ? result.items : []
        };
        state.latestKey = key;
        state.resultsByKey[key] = normalized;
        await writeMonthResultsState(state);
        return normalized;
    }
    async function storeResultImages(result) {
        const key = getResultStorageKey(result);
        const items = Array.isArray(result.items) ? result.items : [];
        let storedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        let totalBytes = 0;
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const mediaId = String(item?.media_id || "");
            const imageUrl = String(item?.media_image_url || "");
            if (!mediaId || !imageUrl) {
                skippedCount += 1;
                continue;
            }
            try {
                const existing = await readImageBlob(mediaId);
                if (existing?.blob?.size) {
                    storedCount += 1;
                    totalBytes += Number(existing.blob.size || 0);
                    continue;
                }
                const blob = await fetchImageBlob(imageUrl);
                await writeImageBlob(mediaId, {
                    mediaId,
                    resultKey: key,
                    sourceUrl: imageUrl,
                    contentType: blob.type || inferImageContentType(imageUrl),
                    size: blob.size,
                    savedAt: new Date().toISOString(),
                    blob
                });
                storedCount += 1;
                totalBytes += Number(blob.size || 0);
            }
            catch (error) {
                failedCount += 1;
                await appendDebugEvent({
                    stage: "image-store-failed",
                    mediaId,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        return {
            key,
            storedCount,
            skippedCount,
            failedCount,
            totalBytes
        };
    }
    async function mergeMonthResultIntoCache(result) {
        const cache = await readCache();
        let inserted = 0;
        let updated = 0;
        for (const item of Array.isArray(result.items) ? result.items : []) {
            if (!item?.media_id || !item?.media_code) {
                continue;
            }
            const existing = cache.itemsByMediaId[item.media_id];
            if (existing) {
                updated += 1;
            }
            else {
                inserted += 1;
            }
            cache.itemsByMediaId[item.media_id] = {
                ...existing,
                mediaId: item.media_id,
                mediaCode: item.media_code,
                mediaImageUrl: item.media_image_url,
                canonicalUrl: `https://www.instagram.com/p/${item.media_code}/`,
                mediaProductType: item.media_product_type,
                mediaType: Number(item.media_type || 0),
                locationName: String(item.location_name || ""),
                icon: String(item.icon || ""),
                imageKeys: extractImageKeys(item.media_image_url),
                firstSeenAt: existing?.firstSeenAt || result.extracted_at,
                lastSeenAt: result.extracted_at,
                capturedAt: result.extracted_at
            };
            cache.mediaCodeToMediaId[item.media_code] = item.media_id;
            for (const imageKey of extractImageKeys(item.media_image_url)) {
                cache.imageKeyToMediaId[imageKey] = item.media_id;
            }
        }
        cache.lastUpdatedAt = result.extracted_at;
        cache.recentRequests = [
            {
                capturedAt: result.extracted_at,
                itemCount: result.count,
                endpoint: getResultStorageKey(result),
                cursor: null
            },
            ...cache.recentRequests
        ].slice(0, 20);
        await writeCache(cache);
        return { inserted, updated };
    }
    async function mergeCapturedItems(payload) {
        const cache = await readCache();
        const requestInfo = payload?.request ?? {};
        const items = Array.isArray(payload?.items) ? payload.items : [];
        let inserted = 0;
        let updated = 0;
        for (const item of items) {
            if (!item?.mediaId || !item?.mediaCode) {
                continue;
            }
            const existing = cache.itemsByMediaId[item.mediaId];
            if (existing) {
                updated += 1;
            }
            else {
                inserted += 1;
            }
            cache.itemsByMediaId[item.mediaId] = {
                ...existing,
                ...item,
                firstSeenAt: existing?.firstSeenAt || item.capturedAt,
                lastSeenAt: item.capturedAt
            };
            cache.mediaCodeToMediaId[item.mediaCode] = item.mediaId;
            for (const imageKey of item.imageKeys || []) {
                cache.imageKeyToMediaId[imageKey] = item.mediaId;
            }
        }
        cache.lastUpdatedAt = new Date().toISOString();
        cache.recentRequests = [
            {
                capturedAt: cache.lastUpdatedAt,
                itemCount: items.length,
                endpoint: requestInfo.endpoint || "",
                cursor: requestInfo.cursor || null
            },
            ...cache.recentRequests
        ].slice(0, 20);
        await writeCache(cache);
        return {
            inserted,
            updated,
            totalItems: Object.keys(cache.itemsByMediaId).length
        };
    }
    async function appendDebugEvent(event) {
        const cache = await readCache();
        cache.debugEvents = [
            {
                at: new Date().toISOString(),
                ...event
            },
            ...cache.debugEvents
        ].slice(0, 40);
        await writeCache(cache);
    }
    async function initializeStorage() {
        const [cache, monthResults, legacy] = await Promise.all([
            readState(APP_STATE_KEYS.cache),
            readState(APP_STATE_KEYS.monthResults),
            chrome.storage.local.get([CACHE_STORAGE_KEY, MONTH_RESULTS_STORAGE_KEY])
        ]);
        await Promise.all([
            cache
                ? Promise.resolve()
                : writeState(APP_STATE_KEYS.cache, normalizeCache(legacy[CACHE_STORAGE_KEY])),
            monthResults
                ? Promise.resolve()
                : writeState(APP_STATE_KEYS.monthResults, {
                    ...normalizeMonthResultsState(legacy[MONTH_RESULTS_STORAGE_KEY])
                })
        ]);
        if (legacy[CACHE_STORAGE_KEY] || legacy[MONTH_RESULTS_STORAGE_KEY]) {
            await chrome.storage.local.remove([CACHE_STORAGE_KEY, MONTH_RESULTS_STORAGE_KEY]);
        }
    }
    async function readCache() {
        const cache = await readState(APP_STATE_KEYS.cache);
        return normalizeCache(cache);
    }
    async function writeCache(cache) {
        await writeState(APP_STATE_KEYS.cache, cache);
    }
    async function writeMonthResultsState(state) {
        await writeState(APP_STATE_KEYS.monthResults, state);
    }
    async function getDb() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(APP_STATE_STORE)) {
                        db.createObjectStore(APP_STATE_STORE, { keyPath: "id" });
                    }
                    if (!db.objectStoreNames.contains(IMAGE_STORE)) {
                        db.createObjectStore(IMAGE_STORE, { keyPath: "mediaId" });
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB."));
            });
        }
        return dbPromise;
    }
    async function readState(id) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(APP_STATE_STORE, "readonly");
            const store = transaction.objectStore(APP_STATE_STORE);
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error || new Error(`Failed to read state: ${id}`));
        });
    }
    async function writeState(id, value) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(APP_STATE_STORE, "readwrite");
            const store = transaction.objectStore(APP_STATE_STORE);
            const request = store.put({ id, value });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => {
                reject(transaction.error || request.error || new Error(`Failed to write state: ${id}`));
            };
            transaction.onabort = () => {
                reject(transaction.error || request.error || new Error(`Aborted write state: ${id}`));
            };
        });
    }
    async function readImageBlob(mediaId) {
        if (!mediaId) {
            return null;
        }
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(IMAGE_STORE, "readonly");
            const store = transaction.objectStore(IMAGE_STORE);
            const request = store.get(mediaId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error(`Failed to read image: ${mediaId}`));
        });
    }
    async function countImageBlobs() {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(IMAGE_STORE, "readonly");
            const store = transaction.objectStore(IMAGE_STORE);
            const request = store.count();
            request.onsuccess = () => resolve(Number(request.result || 0));
            request.onerror = () => reject(request.error || new Error("Failed to count stored images."));
        });
    }
    async function readImageBlobPage(offset, limit) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const results = [];
            let skipped = 0;
            const transaction = db.transaction(IMAGE_STORE, "readonly");
            const store = transaction.objectStore(IMAGE_STORE);
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || results.length >= limit) {
                    resolve(results);
                    return;
                }
                if (skipped < offset) {
                    skipped += 1;
                    cursor.continue();
                    return;
                }
                results.push(cursor.value);
                cursor.continue();
            };
            request.onerror = () => reject(request.error || new Error("Failed to read stored images."));
        });
    }
    async function writeImageBlob(mediaId, value) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(IMAGE_STORE, "readwrite");
            const store = transaction.objectStore(IMAGE_STORE);
            const request = store.put({ ...value, mediaId });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => {
                reject(transaction.error || request.error || new Error(`Failed to write image: ${mediaId}`));
            };
            transaction.onabort = () => {
                reject(transaction.error || request.error || new Error(`Aborted image write: ${mediaId}`));
            };
        });
    }
    async function fetchImageBlob(imageUrl) {
        const response = await fetch(imageUrl, {
            method: "GET",
            credentials: "include",
            cache: "reload"
        });
        if (!response.ok) {
            throw new Error(`Image fetch failed with HTTP ${response.status}.`);
        }
        const blob = await response.blob();
        if (!blob.size) {
            throw new Error("Image fetch returned an empty blob.");
        }
        return blob;
    }
    async function blobToBase64(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const chunkSize = 0x8000;
        let binary = "";
        for (let index = 0; index < bytes.length; index += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
        }
        return btoa(binary);
    }
    async function getActiveInstagramTab() {
        const tabs = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true
        });
        const tab = tabs[0];
        if (!tab?.id || typeof tab.url !== "string") {
            return null;
        }
        if (!tab.url.startsWith("https://www.instagram.com/")) {
            return null;
        }
        return tab;
    }
    function emptyCache() {
        return {
            itemsByMediaId: {},
            mediaCodeToMediaId: {},
            imageKeyToMediaId: {},
            recentRequests: [],
            debugEvents: [],
            lastUpdatedAt: null
        };
    }
    function normalizeCache(cache) {
        return {
            ...emptyCache(),
            ...(cache || {}),
            itemsByMediaId: { ...(cache?.itemsByMediaId || {}) },
            mediaCodeToMediaId: { ...(cache?.mediaCodeToMediaId || {}) },
            imageKeyToMediaId: { ...(cache?.imageKeyToMediaId || {}) },
            recentRequests: Array.isArray(cache?.recentRequests) ? cache.recentRequests : [],
            debugEvents: Array.isArray(cache?.debugEvents) ? cache.debugEvents : []
        };
    }
    function normalizeMonthResultsState(state) {
        return {
            latestKey: typeof state?.latestKey === "string" ? state.latestKey : null,
            resultsByKey: { ...(state?.resultsByKey || {}) }
        };
    }
    function monthStorageKey(year, month) {
        return `instagram_liked_posts_${year}_${String(month).padStart(2, "0")}`;
    }
    function rangeStorageKey(startDate, endDate) {
        return `instagram_liked_posts_${startDate}_to_${endDate}`;
    }
    function getResultStorageKey(result) {
        if (result?.start_date && result?.end_date) {
            return rangeStorageKey(result.start_date, result.end_date);
        }
        return monthStorageKey(result.year, result.month);
    }
    function summarizeResult(result) {
        if (!result) {
            return null;
        }
        return {
            source: String(result.source || "instagram_activity_center_likes"),
            year: Number.isFinite(Number(result.year)) ? Number(result.year) : null,
            month: Number.isFinite(Number(result.month)) ? Number(result.month) : null,
            label: String(result.label || "month"),
            start_date: result.start_date ? String(result.start_date) : null,
            end_date: result.end_date ? String(result.end_date) : null,
            extracted_at: String(result.extracted_at || ""),
            count: Number(result.count || 0),
            page_count: Number(result.page_count || 0),
            request_date_range: result.request_date_range || null
        };
    }
    function inferImageExtension(urlString) {
        try {
            const url = new URL(String(urlString || ""));
            const pathname = url.pathname || "";
            const dotIndex = pathname.lastIndexOf(".");
            if (dotIndex !== -1) {
                const ext = pathname.slice(dotIndex).toLowerCase();
                if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp") {
                    return ext;
                }
            }
        }
        catch (_error) {
            // Fall through to default extension.
        }
        return ".jpg";
    }
    function inferImageContentType(urlString) {
        const extension = inferImageExtension(urlString);
        if (extension === ".png") {
            return "image/png";
        }
        if (extension === ".webp") {
            return "image/webp";
        }
        return "image/jpeg";
    }
    function extractImageKeys(urlString) {
        const keys = new Set();
        try {
            const url = new URL(urlString);
            const igCacheKey = url.searchParams.get("ig_cache_key");
            if (igCacheKey) {
                keys.add(`ig_cache_key:${igCacheKey}`);
            }
            keys.add(`pathname:${url.pathname}`);
        }
        catch (_error) {
            if (urlString) {
                keys.add(`raw:${urlString}`);
            }
        }
        return [...keys];
    }
})();
