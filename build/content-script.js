(() => {
    const LIKES_PATH_PREFIX = "/your_activity/interactions/likes";
    const POST_PATH_REGEX = /^\/p\/[^/]+\/?$/;
    const PAGE_MESSAGE_TYPE = "INSTAGRAM_LIKED_PAYLOAD_CAPTURED";
    const PAGE_COMMAND_MESSAGE_TYPE = "INSTAGRAM_LIKED_EXTRACTOR_COMMAND";
    const PAGE_RESULT_MESSAGE_TYPE = "INSTAGRAM_LIKED_EXTRACTOR_RESULT";
    const PAGE_PROGRESS_MESSAGE_TYPE = "INSTAGRAM_LIKED_EXTRACTOR_PROGRESS";
    const BOUND_CARD_ATTR = "data-insta-liked-url";
    const BOUND_MEDIA_ID_ATTR = "data-insta-liked-media-id";
    const HANDLER_ATTACHED_ATTR = "data-insta-liked-handler-attached";
    const ACTIVE_PRESS_ATTR = "data-insta-liked-active";
    const CARD_SELECTOR = '[data-interactable*="click"]';
    const OVERLAY_PANEL_ID = "insta-liked-overlay";
    const OVERLAY_TOGGLE_ID = "insta-liked-overlay-toggle";
    const OVERLAY_STATE_STORAGE_KEY = "insta-liked-overlay-state";
    const cachedMediaByImageKey = new Map();
    const cachedMediaById = new Map();
    const pointerDownState = new Map();
    const pendingPageCommands = new Map();
    const overlayState = {
        selectedYear: new Date().getFullYear(),
        selectedMonth: new Date().getMonth() + 1,
        monthPickerOpen: false,
        fetchMenuOpen: false,
        collapsed: false,
        extractorReady: false,
        latestSummaryText: "None",
        hasRefreshTemplate: false,
        hasNextTemplate: false,
        monthCountsByYear: {},
        fetchInProgress: false,
        activeRequestKey: null,
        activeWeekIndex: null,
        fetchStatusText: "",
        exportInProgress: false,
        monthScrollTopByKey: {},
        pendingScrollRestore: false,
        progress: null,
        activeMonthResults: [],
        activeResultDetail: null,
        pendingNavigationUrl: null
    };
    let reconcileScheduled = false;
    let hydrateVisibleCardsScheduled = false;
    let pageCommandCounter = 0;
    restoreOverlayState();
    installStyles();
    emitDebugEvent({ stage: "content-script-start", href: location.href });
    hydrateCache();
    installPageMessageForwarder();
    installRuntimeMessageHandler();
    installInteractionOverride();
    installRouteWatcher();
    installDomBindingWatcher();
    installOverlay();
    installOverlayDismissHandlers();
    scheduleReconcile();
    scheduleHydrateVisibleCards();
    async function hydrateCache() {
        const response = await chrome.runtime.sendMessage({ type: "GET_CACHE_SUMMARY" }).catch(() => null);
        if (!response?.ok) {
            emitDebugEvent({ stage: "hydrate-failed" });
            return;
        }
        emitDebugEvent({
            stage: "hydrate-ok",
            itemCount: response.summary?.itemCount || 0
        });
        scheduleHydrateVisibleCards();
    }
    function installPageMessageForwarder() {
        window.addEventListener("message", async (event) => {
            if (event.source !== window) {
                return;
            }
            const message = event.data;
            if (message?.type === PAGE_PROGRESS_MESSAGE_TYPE) {
                handlePageCommandProgress(message);
                return;
            }
            if (message?.type === PAGE_RESULT_MESSAGE_TYPE) {
                settlePageCommand(message);
                return;
            }
            if (!message || message.type !== PAGE_MESSAGE_TYPE) {
                return;
            }
            const payload = message.payload;
            emitDebugEvent({
                stage: "bridge-message",
                endpoint: payload?.request?.endpoint || "",
                itemCount: Array.isArray(payload?.items) ? payload.items.length : 0
            });
            for (const item of payload?.items || []) {
                cacheMedia(item);
            }
            scheduleReconcile();
            scheduleHydrateVisibleCards();
            if (shouldShowOverlay()) {
                void refreshExtractorStatus();
            }
            await chrome.runtime.sendMessage({
                type: "LIKED_ITEMS_CAPTURED",
                payload
            }).catch(() => null);
        });
    }
    function installRuntimeMessageHandler() {
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (!message || typeof message !== "object") {
                return false;
            }
            if (message.type === "GET_EXTRACTOR_STATUS") {
                runPageCommand("GET_STATUS")
                    .then((payload) => sendResponse({ ok: true, payload }))
                    .catch((error) => sendResponse({ ok: false, error: String(error) }));
                return true;
            }
            return false;
        });
    }
    function runPageCommand(action, payload = {}, options = {}) {
        const requestId = `${Date.now()}:${++pageCommandCounter}`;
        return new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
                pendingPageCommands.delete(requestId);
                reject(new Error(`Timed out waiting for page command: ${action}`));
            }, 190000);
            pendingPageCommands.set(requestId, {
                resolve,
                reject,
                timeoutId,
                onProgress: typeof options.onProgress === "function" ? options.onProgress : null
            });
            window.postMessage({
                type: PAGE_COMMAND_MESSAGE_TYPE,
                requestId,
                action,
                payload
            }, "*");
        });
    }
    function postPageCommand(action, payload = {}) {
        const requestId = `${Date.now()}:${++pageCommandCounter}`;
        window.postMessage({
            type: PAGE_COMMAND_MESSAGE_TYPE,
            requestId,
            action,
            payload
        }, "*");
    }
    function handlePageCommandProgress(message) {
        const requestId = String(message.requestId || "");
        const pending = pendingPageCommands.get(requestId);
        if (!pending?.onProgress) {
            return;
        }
        pending.onProgress(message.payload || {});
    }
    function settlePageCommand(message) {
        const requestId = String(message.requestId || "");
        const pending = pendingPageCommands.get(requestId);
        if (!pending) {
            return;
        }
        pendingPageCommands.delete(requestId);
        window.clearTimeout(pending.timeoutId);
        if (message.ok) {
            pending.resolve(message.payload);
            return;
        }
        pending.reject(new Error(String(message.error || "Unknown page command failure")));
    }
    function installOverlay() {
        if (document.getElementById(OVERLAY_PANEL_ID) || document.getElementById(OVERLAY_TOGGLE_ID)) {
            return;
        }
        const panel = document.createElement("section");
        panel.id = OVERLAY_PANEL_ID;
        panel.addEventListener("scroll", captureOverlayScroll, { passive: true });
        const toggle = document.createElement("button");
        toggle.id = OVERLAY_TOGGLE_ID;
        toggle.type = "button";
        toggle.textContent = "Likes";
        toggle.addEventListener("click", () => {
            overlayState.collapsed = false;
            persistOverlayState();
            renderOverlay();
        });
        document.documentElement.appendChild(panel);
        document.documentElement.appendChild(toggle);
        void hydrateOverlay();
        renderOverlay();
    }
    function installOverlayDismissHandlers() {
        document.addEventListener("pointerdown", (event) => {
            if (!overlayState.monthPickerOpen && !overlayState.fetchMenuOpen) {
                return;
            }
            const target = event.target;
            if (target instanceof Element &&
                (target.closest(".insta-liked-overlay-month-picker-shell") ||
                    target.closest(".insta-liked-overlay-fetch-shell"))) {
                return;
            }
            overlayState.monthPickerOpen = false;
            overlayState.fetchMenuOpen = false;
            renderOverlay();
        });
    }
    async function hydrateOverlay() {
        await refreshExtractorStatus();
        const appState = await chrome.runtime.sendMessage({ type: "GET_APP_STATE" }).catch(() => null);
        if (appState?.ok) {
            overlayState.latestSummaryText = formatLatestSummaryText(appState.state.latestMonthResult);
        }
        await refreshYearMonthCounts();
        await refreshOverlaySummaries();
        persistOverlayState();
        renderOverlay();
    }
    async function refreshExtractorStatus() {
        const status = await runPageCommand("GET_STATUS").catch((error) => ({
            ready: false,
            reason: String(error)
        }));
        overlayState.extractorReady = Boolean(status?.ready);
        overlayState.hasRefreshTemplate = Boolean(status?.hasRefreshTemplate);
        overlayState.hasNextTemplate = Boolean(status?.hasNextTemplate);
        persistOverlayState();
        renderOverlay();
    }
    async function refreshOverlaySummaries() {
        const response = await chrome.runtime.sendMessage({
            type: "GET_MONTH_RESULTS",
            year: overlayState.selectedYear,
            month: overlayState.selectedMonth
        }).catch(() => null);
        overlayState.activeMonthResults =
            response?.ok && Array.isArray(response.results) ? response.results : [];
        overlayState.pendingScrollRestore = true;
        syncActiveMonthDetail();
    }
    async function refreshYearMonthCounts() {
        const response = await chrome.runtime.sendMessage({
            type: "GET_YEAR_MONTH_COUNTS",
            year: overlayState.selectedYear
        }).catch(() => null);
        overlayState.monthCountsByYear = response?.ok && response.countsByMonth && typeof response.countsByMonth === "object"
            ? response.countsByMonth
            : {};
    }
    function renderOverlay() {
        const panel = document.getElementById(OVERLAY_PANEL_ID);
        const toggle = document.getElementById(OVERLAY_TOGGLE_ID);
        if (!(panel instanceof HTMLElement) || !(toggle instanceof HTMLElement)) {
            return;
        }
        const visible = shouldShowOverlay();
        panel.style.display = visible && !overlayState.collapsed ? "block" : "none";
        toggle.style.display = visible && overlayState.collapsed ? "block" : "none";
        persistOverlayState();
        if (!visible || overlayState.collapsed) {
            return;
        }
        const monthSections = getMonthSections();
        panel.replaceChildren(buildOverlayHeader(), buildOverlayMonthView(monthSections));
        restoreOverlayScroll(panel);
    }
    function buildOverlayHeader() {
        const wrapper = document.createElement("div");
        wrapper.className = "insta-liked-overlay-header";
        const controls = document.createElement("div");
        controls.className = "insta-liked-overlay-top-controls";
        controls.appendChild(buildHeaderFetchButton());
        controls.appendChild(buildHeaderMonthPickerTrigger());
        controls.appendChild(buildHeaderExportButton());
        const closeButton = createIconButton("Close", buildIconSvg("close"));
        closeButton.classList.add("insta-liked-overlay-header-close");
        closeButton.addEventListener("click", () => {
            overlayState.collapsed = true;
            persistOverlayState();
            renderOverlay();
        });
        controls.appendChild(closeButton);
        wrapper.appendChild(controls);
        return wrapper;
    }
    function buildHeaderFetchButton() {
        const shell = document.createElement("div");
        shell.className = "insta-liked-overlay-fetch-shell";
        const fetchButton = document.createElement("button");
        fetchButton.type = "button";
        fetchButton.className = `insta-liked-overlay-button insta-liked-overlay-header-fetch ${getFetchButtonToneClass()}`;
        fetchButton.disabled = !canFetchMonth() || Boolean(overlayState.fetchInProgress);
        fetchButton.title = getFetchButtonTitle();
        fetchButton.textContent = overlayState.fetchInProgress ? "Fetching" : "Fetch";
        fetchButton.addEventListener("click", () => {
            void fetchMonth();
        });
        const menuButton = document.createElement("button");
        menuButton.type = "button";
        menuButton.className = `insta-liked-overlay-button insta-liked-overlay-fetch-menu-toggle ${getFetchButtonToneClass()}`;
        menuButton.disabled = !canFetchMonth() || Boolean(overlayState.fetchInProgress);
        menuButton.title = "More fetch actions";
        menuButton.setAttribute("aria-label", "More fetch actions");
        menuButton.appendChild(buildIconNode(buildIconSvg("chevronDown")));
        menuButton.addEventListener("click", () => {
            overlayState.fetchMenuOpen = !overlayState.fetchMenuOpen;
            renderOverlay();
        });
        shell.appendChild(fetchButton);
        shell.appendChild(menuButton);
        if (overlayState.fetchMenuOpen && !overlayState.fetchInProgress) {
            const menu = document.createElement("div");
            menu.className = "insta-liked-overlay-fetch-menu";
            const fetchYearButton = document.createElement("button");
            fetchYearButton.type = "button";
            fetchYearButton.className = "insta-liked-overlay-fetch-menu-item";
            fetchYearButton.textContent = "Fetch year";
            fetchYearButton.addEventListener("click", () => {
                overlayState.fetchMenuOpen = false;
                renderOverlay();
                void fetchYear();
            });
            menu.appendChild(fetchYearButton);
            shell.appendChild(menu);
        }
        return shell;
    }
    function buildHeaderExportButton() {
        const button = createIconButton(overlayState.exportInProgress ? "Exporting fetched posts and images" : "Export fetched posts and images", overlayState.exportInProgress ? buildIconSvg("spinner") : buildIconSvg("export"));
        button.classList.add("insta-liked-overlay-export-button");
        button.disabled = Boolean(overlayState.exportInProgress);
        button.addEventListener("click", () => {
            void exportFetchedData();
        });
        return button;
    }
    async function exportFetchedData() {
        if (overlayState.exportInProgress) {
            return;
        }
        overlayState.exportInProgress = true;
        renderOverlay();
        try {
            const prepared = await chrome.runtime.sendMessage({ type: "PREPARE_FETCHED_DATA_EXPORT" }).catch((error) => ({
                ok: false,
                error: String(error)
            }));
            if (!prepared?.ok) {
                throw new Error(prepared?.error || "Failed to prepare fetched data export.");
            }
            const jsonParts = [
                "{\n",
                `"source":${JSON.stringify(prepared.exportData?.source || "instagram_liked_posts_extension")},\n`,
                `"exportedAt":${JSON.stringify(prepared.exportData?.exportedAt || new Date().toISOString())},\n`,
                `"summary":${JSON.stringify(prepared.exportData?.summary || {})},\n`,
                `"cache":${JSON.stringify(prepared.exportData?.cache || {})},\n`,
                `"fetchedResults":${JSON.stringify(prepared.exportData?.fetchedResults || {})},\n`,
                "\"images\":[\n"
            ];
            let offset = 0;
            let wroteImage = false;
            while (true) {
                const batch = await chrome.runtime.sendMessage({
                    type: "GET_EXPORT_IMAGE_BATCH",
                    offset,
                    limit: 6
                }).catch((error) => ({
                    ok: false,
                    error: String(error)
                }));
                if (!batch?.ok) {
                    throw new Error(batch?.error || "Failed to export stored images.");
                }
                for (const image of Array.isArray(batch.images) ? batch.images : []) {
                    jsonParts.push(wroteImage ? ",\n" : "");
                    jsonParts.push(JSON.stringify(image));
                    wroteImage = true;
                }
                offset = Number(batch.nextOffset || offset + 6);
                if (batch.done) {
                    break;
                }
            }
            jsonParts.push("\n]\n}");
            downloadJsonParts(jsonParts, prepared.filename || buildExportFilename());
        }
        catch (error) {
            console.error("[insta-likes-ext] export failed", error);
            window.alert(error instanceof Error ? error.message : String(error));
        }
        finally {
            overlayState.exportInProgress = false;
            renderOverlay();
        }
    }
    function downloadJsonParts(parts, filename) {
        const blob = new Blob(parts, {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function buildExportFilename() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        return `instagram-liked-posts-export-${timestamp}.json`;
    }
    async function shiftOverlayYear(offset) {
        overlayState.selectedYear += offset;
        overlayState.activeMonthResults = [];
        overlayState.activeResultDetail = null;
        await refreshYearMonthCounts();
        await refreshOverlaySummaries();
        persistOverlayState();
        renderOverlay();
    }
    async function setSelectedMonth(year, month) {
        if (overlayState.selectedYear === year && overlayState.selectedMonth === month) {
            return;
        }
        overlayState.selectedYear = year;
        overlayState.selectedMonth = month;
        overlayState.activeMonthResults = [];
        overlayState.activeResultDetail = null;
        await refreshYearMonthCounts();
        await refreshOverlaySummaries();
        persistOverlayState();
        renderOverlay();
    }
    function buildHeaderMonthPickerTrigger() {
        const shell = document.createElement("div");
        shell.className = "insta-liked-overlay-month-picker-shell";
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = `insta-liked-overlay-month-trigger${overlayState.monthPickerOpen ? " is-open" : ""}`;
        trigger.title = "Select month";
        trigger.appendChild(buildIconNode(buildIconSvg("calendar")));
        const label = document.createElement("span");
        label.className = "insta-liked-overlay-month-trigger-label";
        label.textContent = `${getMonthNames()[overlayState.selectedMonth - 1].slice(0, 3)} ${overlayState.selectedYear}`;
        trigger.appendChild(label);
        const count = getMonthSections().reduce((sum, section) => sum + section.items.length, 0);
        const meta = document.createElement("span");
        meta.className = "insta-liked-overlay-month-trigger-meta";
        meta.textContent = String(count);
        trigger.appendChild(meta);
        trigger.appendChild(buildIconNode(buildIconSvg("chevronDown")));
        trigger.addEventListener("click", () => {
            overlayState.monthPickerOpen = !overlayState.monthPickerOpen;
            renderOverlay();
        });
        shell.appendChild(trigger);
        if (overlayState.monthPickerOpen) {
            shell.appendChild(buildOverlayMonthPicker());
        }
        return shell;
    }
    function buildOverlayMonthPicker() {
        const wrapper = document.createElement("div");
        wrapper.className = "insta-liked-overlay-picker";
        const yearRow = document.createElement("div");
        yearRow.className = "insta-liked-overlay-year-row";
        const previousYearButton = createIconButton("Previous year", buildIconSvg("chevronLeft"));
        previousYearButton.addEventListener("click", () => {
            void shiftOverlayYear(-1);
        });
        const nextYearButton = createIconButton("Next year", buildIconSvg("chevronRight"));
        nextYearButton.addEventListener("click", () => {
            void shiftOverlayYear(1);
        });
        const yearLabel = document.createElement("div");
        yearLabel.className = "insta-liked-overlay-year-label";
        yearLabel.textContent = String(overlayState.selectedYear);
        yearRow.appendChild(previousYearButton);
        yearRow.appendChild(yearLabel);
        yearRow.appendChild(nextYearButton);
        const monthGrid = document.createElement("div");
        monthGrid.className = "insta-liked-overlay-month-grid";
        getMonthNames().forEach((monthName, index) => {
            const monthNumber = index + 1;
            const monthCount = getSavedCountForMonth(monthNumber);
            const monthButton = document.createElement("button");
            monthButton.type = "button";
            monthButton.className = `insta-liked-overlay-month-chip${overlayState.selectedMonth === monthNumber ? " is-active" : ""}`;
            const monthLabel = document.createElement("span");
            monthLabel.className = "insta-liked-overlay-month-chip-label";
            monthLabel.textContent = monthName.slice(0, 3);
            monthButton.appendChild(monthLabel);
            const monthMeta = document.createElement("span");
            monthMeta.className = "insta-liked-overlay-month-chip-meta";
            monthMeta.textContent = String(monthCount);
            monthButton.appendChild(monthMeta);
            monthButton.addEventListener("click", () => {
                overlayState.monthPickerOpen = false;
                void setSelectedMonth(overlayState.selectedYear, monthNumber);
            });
            monthGrid.appendChild(monthButton);
        });
        wrapper.appendChild(yearRow);
        wrapper.appendChild(monthGrid);
        return wrapper;
    }
    function buildOverlayMonthView(monthSections) {
        const wrapper = document.createElement("div");
        wrapper.className = "insta-liked-overlay-month";
        const toolbar = document.createElement("div");
        toolbar.className = "insta-liked-overlay-month-toolbar";
        const title = document.createElement("div");
        title.className = "insta-liked-overlay-month-title";
        title.textContent = getMonthNames()[overlayState.selectedMonth - 1];
        const meta = document.createElement("div");
        meta.className = "insta-liked-overlay-month-meta";
        meta.textContent = `${monthSections.reduce((sum, section) => sum + section.items.length, 0)} posts`;
        const titleGroup = document.createElement("div");
        titleGroup.className = "insta-liked-overlay-month-title-group";
        titleGroup.appendChild(title);
        titleGroup.appendChild(meta);
        toolbar.appendChild(titleGroup);
        wrapper.appendChild(toolbar);
        if (overlayState.fetchInProgress && overlayState.fetchStatusText) {
            const progress = document.createElement("div");
            progress.className = "insta-liked-overlay-progress is-processing";
            const progressText = document.createElement("div");
            progressText.className = "insta-liked-overlay-progress-text";
            progressText.textContent = overlayState.fetchStatusText;
            progress.appendChild(progressText);
            wrapper.appendChild(progress);
        }
        if (!monthSections.length) {
            const empty = document.createElement("div");
            empty.className = "insta-liked-overlay-empty";
            empty.textContent = "No saved posts for this month.";
            wrapper.appendChild(empty);
            return wrapper;
        }
        const monthBody = document.createElement("div");
        monthBody.className = "insta-liked-overlay-month-body";
        for (const sectionData of monthSections) {
            monthBody.appendChild(buildPeriodGroup(sectionData));
        }
        wrapper.appendChild(monthBody);
        return wrapper;
    }
    function buildPeriodGroup(sectionData) {
        const section = document.createElement("section");
        section.className = "insta-liked-overlay-period";
        const label = document.createElement("div");
        label.className = "insta-liked-overlay-period-label";
        label.textContent = `${formatSectionDateLabel(sectionData)} • ${sectionData.items.length}`;
        section.appendChild(label);
        const list = document.createElement("div");
        list.className = "insta-liked-overlay-thumb-list";
        for (const item of sectionData.items) {
            const thumb = buildThumbButton(item);
            list.appendChild(thumb);
        }
        section.appendChild(list);
        return section;
    }
    function buildThumbButton(item) {
        const thumb = document.createElement("button");
        thumb.type = "button";
        thumb.className = "insta-liked-overlay-thumb";
        if (isCurrentPostUrl(item.canonicalUrl)) {
            thumb.classList.add("is-active");
        }
        if (item.canonicalUrl) {
            thumb.addEventListener("click", () => {
                void openBoundCard(thumb, item.canonicalUrl);
            });
        }
        const image = document.createElement("img");
        image.className = "insta-liked-overlay-thumb-image";
        image.alt = item.label;
        image.loading = "lazy";
        image.src = item.thumbnailUrl;
        thumb.appendChild(image);
        return thumb;
    }
    async function fetchMonth() {
        if (overlayState.fetchInProgress) {
            return;
        }
        const year = overlayState.selectedYear;
        const month = overlayState.selectedMonth;
        const chunks = buildMonthChunks(year, month);
        try {
            startFetchSession(`Preparing ${getMonthNames()[month - 1]} ${year}`);
            for (const chunk of chunks) {
                if (await isResultKeySaved(chunk.storageKey)) {
                    continue;
                }
                const saved = await fetchAndSaveWeekChunk(chunk, year, month);
                await refreshOverlayStateAfterSave();
                if (!saved) {
                    break;
                }
                await delay(2500);
            }
        }
        finally {
            finishFetchSession();
        }
    }
    async function fetchYear() {
        if (overlayState.fetchInProgress) {
            return;
        }
        const year = overlayState.selectedYear;
        const yearRange = {
            startDate: formatDateParts(year, 1, 1),
            endDate: formatDateParts(year, 12, 31)
        };
        try {
            startFetchSession(`Checking ${year}`);
            const yearHasPosts = await probeRangeHasItems({
                ...yearRange,
                year,
                month: null,
                label: `year_${year}`,
                statusText: `Checking ${year}`
            });
            if (!yearHasPosts) {
                overlayState.fetchStatusText = `No posts found in ${year}`;
                persistOverlayState();
                renderOverlay();
                return;
            }
            const quarterRanges = buildQuarterRanges(year);
            const monthNumbersWithPosts = [];
            for (const quarter of quarterRanges) {
                const quarterHasPosts = await probeRangeHasItems({
                    startDate: quarter.startDate,
                    endDate: quarter.endDate,
                    year,
                    month: null,
                    label: `quarter_${quarter.index}`,
                    statusText: `Checking Q${quarter.index} ${year}`
                });
                if (!quarterHasPosts) {
                    continue;
                }
                for (const monthNumber of quarter.months) {
                    const monthRange = buildMonthRange(year, monthNumber);
                    const monthHasPosts = await probeRangeHasItems({
                        startDate: monthRange.startDate,
                        endDate: monthRange.endDate,
                        year,
                        month: monthNumber,
                        label: `month_${year}_${String(monthNumber).padStart(2, "0")}`,
                        statusText: `Checking ${getMonthNames()[monthNumber - 1]} ${year}`
                    });
                    if (monthHasPosts) {
                        monthNumbersWithPosts.push(monthNumber);
                    }
                }
            }
            for (const monthNumber of monthNumbersWithPosts) {
                for (const chunk of buildMonthChunks(year, monthNumber)) {
                    if (await isResultKeySaved(chunk.storageKey)) {
                        continue;
                    }
                    const saved = await fetchAndSaveWeekChunk(chunk, year, monthNumber);
                    await refreshOverlayStateAfterSave();
                    if (!saved) {
                        return;
                    }
                    await delay(2500);
                }
            }
        }
        finally {
            finishFetchSession();
        }
    }
    async function fetchAndSaveWeekChunk(chunk, year, month) {
        const result = await extractRange({
            requestKey: chunk.storageKey,
            statusText: `Fetched 0 items in week ${chunk.index}`,
            onProgress: (itemCount) => {
                overlayState.fetchStatusText = `Fetched ${itemCount} items in week ${chunk.index}`;
            },
            payload: {
                startDate: chunk.startDate,
                endDate: chunk.endDate,
                year,
                month,
                label: "range_chunk",
                sort: "oldest_to_newest",
                maxPages: 100
            }
        });
        if (!result) {
            return false;
        }
        const saved = await chrome.runtime.sendMessage({
            type: "SAVE_EXTRACTION_RESULT",
            result
        }).catch(() => null);
        if (!saved?.ok) {
            throw new Error(saved?.error || "Failed to save extracted items.");
        }
        overlayState.latestSummaryText = formatLatestSummaryText(saved.payload?.result || result);
        return true;
    }
    async function probeRangeHasItems({ startDate, endDate, year, month, label, statusText }) {
        const result = await extractRange({
            requestKey: `probe:${label}:${startDate}:${endDate}`,
            statusText,
            payload: {
                startDate,
                endDate,
                year,
                month,
                label,
                sort: "oldest_to_newest",
                maxPages: 1
            }
        });
        return Boolean(result && Number(result.count || 0) > 0);
    }
    async function extractRange({ requestKey, statusText, payload, onProgress = null }) {
        if (overlayState.activeRequestKey) {
            return null;
        }
        overlayState.activeRequestKey = requestKey;
        overlayState.activeWeekIndex =
            payload?.label === "range_chunk"
                ? Number(findWeekIndexForDates(payload.startDate, payload.endDate) || 0)
                : null;
        overlayState.fetchStatusText = statusText;
        overlayState.progress = {
            itemCount: 0,
            pageCount: 0
        };
        persistOverlayState();
        renderOverlay();
        try {
            const result = await runPageCommand("EXTRACT_RANGE", payload, {
                onProgress: (progressPayload) => {
                    const itemCount = Number(progressPayload?.itemCount || overlayState.progress?.itemCount || 0);
                    overlayState.progress = {
                        itemCount,
                        pageCount: Number(progressPayload?.pageCount || overlayState.progress?.pageCount || 0)
                    };
                    if (typeof onProgress === "function") {
                        onProgress(itemCount, progressPayload);
                    }
                    persistOverlayState();
                    renderOverlay();
                }
            });
            return result;
        }
        catch (error) {
            console.error("[insta-likes-ext] extraction failed", error);
            return null;
        }
        finally {
            overlayState.activeRequestKey = null;
            overlayState.activeWeekIndex = null;
            persistOverlayState();
        }
    }
    async function refreshOverlayStateAfterSave() {
        await refreshYearMonthCounts();
        await refreshOverlaySummaries();
        persistOverlayState();
        renderOverlay();
    }
    function startFetchSession(statusText) {
        overlayState.fetchMenuOpen = false;
        overlayState.fetchInProgress = true;
        overlayState.fetchStatusText = statusText;
        persistOverlayState();
        renderOverlay();
    }
    function finishFetchSession() {
        overlayState.fetchInProgress = false;
        overlayState.activeRequestKey = null;
        overlayState.activeWeekIndex = null;
        overlayState.fetchStatusText = "";
        overlayState.progress = null;
        persistOverlayState();
        renderOverlay();
        flushQueuedNavigation();
    }
    async function isResultKeySaved(storageKey) {
        const response = await chrome.runtime.sendMessage({
            type: "GET_RESULT_SUMMARIES",
            keys: [storageKey]
        }).catch(() => null);
        return Boolean(response?.ok && response.summariesByKey && response.summariesByKey[storageKey]);
    }
    function buildQuarterRanges(year) {
        return [
            { index: 1, months: [1, 2, 3] },
            { index: 2, months: [4, 5, 6] },
            { index: 3, months: [7, 8, 9] },
            { index: 4, months: [10, 11, 12] }
        ].map((quarter) => {
            const firstMonth = quarter.months[0];
            const lastMonth = quarter.months[quarter.months.length - 1];
            return {
                ...quarter,
                startDate: formatDateParts(year, firstMonth, 1),
                endDate: formatDateParts(year, lastMonth, new Date(Date.UTC(year, lastMonth, 0)).getUTCDate())
            };
        });
    }
    function buildMonthRange(year, month) {
        return {
            startDate: formatDateParts(year, month, 1),
            endDate: formatDateParts(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate())
        };
    }
    function findWeekIndexForDates(startDate, endDate) {
        const match = String(startDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) {
            return null;
        }
        const year = Number(match[1]);
        const month = Number(match[2]);
        const chunk = buildMonthChunks(year, month).find((entry) => entry.startDate === startDate && entry.endDate === endDate);
        return chunk?.index || null;
    }
    function flushQueuedNavigation() {
        if (!overlayState.pendingNavigationUrl) {
            return;
        }
        const pendingUrl = overlayState.pendingNavigationUrl;
        overlayState.pendingNavigationUrl = null;
        postPageCommand("NAVIGATE_TO_MEDIA", { url: pendingUrl });
    }
    function installInteractionOverride() {
        document.addEventListener("pointerdown", handlePointerDown, true);
        document.addEventListener("pointerup", handlePointerEnd, true);
        document.addEventListener("pointercancel", handlePointerEnd, true);
        document.addEventListener("click", handleClick, true);
        document.addEventListener("keydown", handleKeydown, true);
    }
    async function handlePointerDown(event) {
        if (!isLikesPage()) {
            return;
        }
        const card = findCardFromEvent(event);
        if (!card) {
            return;
        }
        let boundUrl = card.getAttribute(BOUND_CARD_ATTR);
        if (!boundUrl) {
            const media = await resolveMediaForCard(card);
            if (media?.canonicalUrl) {
                bindCard(card, media);
                attachDirectHandlers(card);
                boundUrl = media.canonicalUrl;
            }
            else {
                scheduleHydrateVisibleCards();
                scheduleReconcile();
                return;
            }
        }
        if (!boundUrl) {
            return;
        }
        pointerDownState.set(event.pointerId, {
            card,
            url: boundUrl
        });
        card.setAttribute(ACTIVE_PRESS_ATTR, "true");
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }
    function handlePointerEnd(event) {
        const state = pointerDownState.get(event.pointerId);
        if (!state) {
            return;
        }
        pointerDownState.delete(event.pointerId);
        state.card.removeAttribute(ACTIVE_PRESS_ATTR);
    }
    async function handleClick(event) {
        if (!isLikesPage()) {
            return;
        }
        const card = findCardFromEvent(event);
        if (!card) {
            return;
        }
        let boundUrl = findPointerDownUrlForCard(card);
        if (!boundUrl) {
            boundUrl = card.getAttribute(BOUND_CARD_ATTR);
        }
        if (!boundUrl) {
            const media = await resolveMediaForCard(card);
            if (media?.canonicalUrl) {
                bindCard(card, media);
                attachDirectHandlers(card);
                boundUrl = media.canonicalUrl;
            }
        }
        if (!boundUrl) {
            emitDebugEvent({ stage: "click-no-match" });
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        await openBoundCard(card, boundUrl);
    }
    async function handleKeydown(event) {
        if (isDetailNavigationKey(event)) {
            if (!shouldHandleDetailNavigationKey(event)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            await navigateActiveDetail(event.key === "ArrowDown" ? 1 : -1);
            return;
        }
        if (!isLikesPage()) {
            return;
        }
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }
        const card = findCardFromEvent(event);
        if (!card) {
            return;
        }
        let boundUrl = card.getAttribute(BOUND_CARD_ATTR);
        if (!boundUrl) {
            const media = await resolveMediaForCard(card);
            if (media?.canonicalUrl) {
                bindCard(card, media);
                attachDirectHandlers(card);
                boundUrl = media.canonicalUrl;
            }
        }
        if (!boundUrl) {
            emitDebugEvent({ stage: "keyboard-no-match" });
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        await openBoundCard(card, boundUrl);
    }
    async function openBoundCard(card, url) {
        const panel = document.getElementById(OVERLAY_PANEL_ID);
        if (panel instanceof HTMLElement) {
            overlayState.monthScrollTopByKey[getSelectedMonthStorageKey()] = panel.scrollTop;
            persistOverlayState();
        }
        if (overlayState.fetchInProgress) {
            overlayState.pendingNavigationUrl = url;
            persistOverlayState();
            emitDebugEvent({ stage: "click-queued-during-fetch", url, requestKey: overlayState.activeRequestKey });
            return;
        }
        card.dataset.instaLikedOpening = "true";
        postPageCommand("NAVIGATE_TO_MEDIA", { url });
        emitDebugEvent({ stage: "click-opened", url });
    }
    function installRouteWatcher() {
        let previousHref = location.href;
        const observer = new MutationObserver(() => {
            if (location.href === previousHref) {
                return;
            }
            previousHref = location.href;
            emitDebugEvent({ stage: "route-change", href: previousHref });
            scheduleReconcile();
            scheduleHydrateVisibleCards();
            if (shouldShowOverlay()) {
                void hydrateOverlay();
            }
            else {
                renderOverlay();
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }
    function installDomBindingWatcher() {
        const observer = new MutationObserver(() => {
            if (!isLikesPage()) {
                return;
            }
            scheduleReconcile();
            scheduleHydrateVisibleCards();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["src"]
        });
    }
    function scheduleReconcile() {
        if (reconcileScheduled) {
            return;
        }
        reconcileScheduled = true;
        queueMicrotask(() => {
            reconcileScheduled = false;
            reconcileBindings();
        });
    }
    function scheduleHydrateVisibleCards() {
        if (hydrateVisibleCardsScheduled) {
            return;
        }
        hydrateVisibleCardsScheduled = true;
        queueMicrotask(async () => {
            hydrateVisibleCardsScheduled = false;
            await hydrateVisibleCardsFromStorage();
            scheduleReconcile();
        });
    }
    function reconcileBindings() {
        if (!isLikesPage()) {
            return;
        }
        const cards = [...document.querySelectorAll(CARD_SELECTOR)];
        let boundCount = 0;
        for (const card of cards) {
            const media = resolveMediaForCardSync(card);
            if (!media?.canonicalUrl) {
                continue;
            }
            bindCard(card, media);
            attachDirectHandlers(card);
            boundCount += 1;
        }
        emitDebugEvent({
            stage: "reconcile",
            boundCount
        });
    }
    function bindCard(card, media) {
        card.setAttribute(BOUND_CARD_ATTR, media.canonicalUrl);
        card.setAttribute(BOUND_MEDIA_ID_ATTR, media.mediaId);
        card.style.cursor = "grab";
        const focusTarget = card.querySelector('[role="button"]');
        if (focusTarget instanceof HTMLElement) {
            focusTarget.style.cursor = "grab";
        }
        const image = card.querySelector("img");
        if (image instanceof HTMLElement) {
            image.style.cursor = "grab";
        }
    }
    function attachDirectHandlers(card) {
        if (card.getAttribute(HANDLER_ATTACHED_ATTR) === "true") {
            return;
        }
        const handler = async (event) => {
            const boundUrl = card.getAttribute(BOUND_CARD_ATTR);
            if (!boundUrl) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            await openBoundCard(card, boundUrl);
        };
        card.addEventListener("click", handler, true);
        const focusTarget = card.querySelector('[role="button"]');
        if (focusTarget instanceof HTMLElement) {
            focusTarget.addEventListener("click", handler, true);
            focusTarget.addEventListener("keydown", async (event) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    return;
                }
                const boundUrl = card.getAttribute(BOUND_CARD_ATTR);
                if (!boundUrl) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                await openBoundCard(card, boundUrl);
            }, true);
        }
        card.setAttribute(HANDLER_ATTACHED_ATTR, "true");
    }
    function findCardFromEvent(event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return null;
        }
        return target.closest(CARD_SELECTOR);
    }
    async function resolveMediaForCard(card) {
        const syncMatch = resolveMediaForCardSync(card);
        if (syncMatch) {
            return syncMatch;
        }
        const image = card.querySelector("img");
        if (!image) {
            return null;
        }
        const imageKeys = extractImageKeys(image.currentSrc || image.src);
        for (const imageKey of imageKeys) {
            const response = await chrome.runtime.sendMessage({
                type: "GET_MEDIA_FOR_IMAGE_KEY",
                imageKey
            }).catch(() => null);
            if (response?.ok && response.item) {
                cacheMedia(response.item);
                return response.item;
            }
        }
        return null;
    }
    function resolveMediaForCardSync(card) {
        const boundMediaId = card.getAttribute(BOUND_MEDIA_ID_ATTR);
        if (boundMediaId && cachedMediaById.has(boundMediaId)) {
            return cachedMediaById.get(boundMediaId);
        }
        const image = card.querySelector("img");
        if (!image) {
            return null;
        }
        const imageKeys = extractImageKeys(image.currentSrc || image.src);
        for (const imageKey of imageKeys) {
            const media = cachedMediaByImageKey.get(imageKey);
            if (media) {
                return media;
            }
        }
        return null;
    }
    function cacheMedia(item) {
        if (!item?.mediaId) {
            return;
        }
        cachedMediaById.set(item.mediaId, item);
        for (const imageKey of item.imageKeys || []) {
            cachedMediaByImageKey.set(imageKey, item);
        }
    }
    async function hydrateVisibleCardsFromStorage() {
        if (!isLikesPage()) {
            return;
        }
        const cards = [...document.querySelectorAll(CARD_SELECTOR)];
        const missingImageKeys = new Set();
        for (const card of cards) {
            if (card.getAttribute(BOUND_CARD_ATTR)) {
                continue;
            }
            const image = card.querySelector("img");
            if (!image) {
                continue;
            }
            for (const imageKey of extractImageKeys(image.currentSrc || image.src)) {
                if (!cachedMediaByImageKey.has(imageKey)) {
                    missingImageKeys.add(imageKey);
                }
            }
        }
        if (!missingImageKeys.size) {
            return;
        }
        const response = await chrome.runtime.sendMessage({
            type: "GET_MEDIA_FOR_IMAGE_KEYS",
            imageKeys: [...missingImageKeys]
        }).catch(() => null);
        if (!response?.ok || !response.itemsByImageKey) {
            return;
        }
        for (const item of Object.values(response.itemsByImageKey)) {
            cacheMedia(item);
        }
        emitDebugEvent({
            stage: "hydrate-visible-cards",
            matchedCount: Object.keys(response.itemsByImageKey).length
        });
    }
    function emitDebugEvent(payload) {
        try {
            chrome.runtime.sendMessage({
                type: "DEBUG_EVENT",
                payload
            }).catch(() => null);
        }
        catch (_error) {
            // This happens when the page still has the old content script after extension reload.
        }
    }
    function isLikesPage() {
        return location.pathname.startsWith(LIKES_PATH_PREFIX);
    }
    function restoreOverlayState() {
        try {
            const raw = window.sessionStorage.getItem(OVERLAY_STATE_STORAGE_KEY);
            if (!raw) {
                return;
            }
            const saved = JSON.parse(raw);
            if (!saved || typeof saved !== "object") {
                return;
            }
            const selectedYear = Number(saved.selectedYear);
            const selectedMonth = Number(saved.selectedMonth);
            overlayState.selectedYear = Number.isFinite(selectedYear)
                ? selectedYear
                : overlayState.selectedYear;
            overlayState.selectedMonth =
                Number.isFinite(selectedMonth) && selectedMonth >= 1 && selectedMonth <= 12
                    ? selectedMonth
                    : overlayState.selectedMonth;
            overlayState.collapsed = Boolean(saved.collapsed);
            if (typeof saved.latestSummaryText === "string" && saved.latestSummaryText) {
                overlayState.latestSummaryText = saved.latestSummaryText;
            }
            overlayState.monthScrollTopByKey =
                saved.monthScrollTopByKey && typeof saved.monthScrollTopByKey === "object"
                    ? { ...saved.monthScrollTopByKey }
                    : {};
        }
        catch (_error) {
            // Ignore corrupted persisted UI state.
        }
    }
    function persistOverlayState() {
        try {
            window.sessionStorage.setItem(OVERLAY_STATE_STORAGE_KEY, JSON.stringify({
                selectedYear: overlayState.selectedYear,
                selectedMonth: overlayState.selectedMonth,
                collapsed: overlayState.collapsed,
                latestSummaryText: overlayState.latestSummaryText,
                monthScrollTopByKey: overlayState.monthScrollTopByKey
            }));
        }
        catch (_error) {
            // Ignore storage quota or transient sessionStorage failures.
        }
    }
    function syncActiveMonthDetail() {
        const items = [];
        for (const result of overlayState.activeMonthResults) {
            items.push(...normalizeResultItems(result));
        }
        overlayState.activeResultDetail = items.length
            ? {
                key: `${overlayState.selectedYear}-${overlayState.selectedMonth}`,
                title: `${getMonthNames()[overlayState.selectedMonth - 1]} ${overlayState.selectedYear}`,
                items
            }
            : null;
    }
    function normalizeResultItems(result) {
        return Array.isArray(result?.items)
            ? result.items
                .map((item) => ({
                label: item?.media_code || "item",
                thumbnailUrl: item?.media_image_url || "",
                canonicalUrl: item?.canonicalUrl ||
                    (item?.media_code ? `https://www.instagram.com/p/${item.media_code}/` : "")
            }))
                .filter((item) => item.thumbnailUrl)
            : [];
    }
    function isPostPage() {
        return POST_PATH_REGEX.test(location.pathname);
    }
    function shouldShowOverlay() {
        return isLikesPage() || isPostPage();
    }
    function isDetailNavigationKey(event) {
        return event.key === "ArrowDown" || event.key === "ArrowUp";
    }
    function shouldHandleDetailNavigationKey(event) {
        const target = event.target;
        if (target instanceof Element &&
            target.matches("input, textarea, select, [contenteditable='true'], [contenteditable='']")) {
            return false;
        }
        return Boolean(overlayState.activeResultDetail?.items?.length);
    }
    function getActiveDetailNavigationState() {
        const detail = overlayState.activeResultDetail;
        if (!detail?.items?.length) {
            return null;
        }
        const currentPath = normalizePath(location.pathname);
        const index = detail.items.findIndex((item) => {
            if (!item?.canonicalUrl) {
                return false;
            }
            try {
                return normalizePath(new URL(item.canonicalUrl).pathname) === currentPath;
            }
            catch (_error) {
                return false;
            }
        });
        if (index < 0) {
            return null;
        }
        return {
            index,
            item: detail.items[index]
        };
    }
    async function navigateActiveDetail(offset) {
        const detail = overlayState.activeResultDetail;
        if (!detail?.items?.length) {
            return;
        }
        const nextIndex = getSequentialDetailIndex(detail.items.length, offset, getActiveDetailNavigationState()?.index ?? 0);
        const nextItem = detail.items[nextIndex];
        if (!nextItem?.canonicalUrl) {
            return;
        }
        const panel = document.getElementById(OVERLAY_PANEL_ID);
        if (panel instanceof HTMLElement) {
            const thumbs = panel.querySelectorAll(".insta-liked-overlay-thumb");
            const thumb = thumbs.item(nextIndex);
            if (thumb instanceof HTMLElement) {
                await openBoundCard(thumb, nextItem.canonicalUrl);
                return;
            }
        }
        await openBoundCard(document.body || document.documentElement, nextItem.canonicalUrl);
    }
    function getSequentialDetailIndex(length, offset, currentIndex) {
        return ((currentIndex + offset) % length + length) % length;
    }
    function normalizePath(pathname) {
        return String(pathname || "").replace(/\/?$/, "/");
    }
    function isCurrentPostUrl(urlString) {
        try {
            return normalizePath(new URL(urlString, location.origin).pathname) === normalizePath(location.pathname);
        }
        catch (_error) {
            return false;
        }
    }
    function getMonthNames() {
        return [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December"
        ];
    }
    function buildMonthChunks(year, month) {
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const chunks = [];
        let currentDay = 1;
        let index = 0;
        while (currentDay <= daysInMonth) {
            const startDay = currentDay;
            const endDay = Math.min(currentDay + 6, daysInMonth);
            const dayCount = endDay - startDay + 1;
            const startDate = formatDateParts(year, month, startDay);
            const endDate = formatDateParts(year, month, endDay);
            chunks.push({
                index: index + 1,
                dayCount,
                startDate,
                endDate,
                storageKey: `instagram_liked_posts_${startDate}_to_${endDate}`
            });
            currentDay = endDay + 1;
            index += 1;
        }
        return chunks;
    }
    function canFetchMonth() {
        return Boolean(overlayState.hasRefreshTemplate);
    }
    function getFetchButtonToneClass() {
        if (overlayState.fetchInProgress) {
            return "is-busy";
        }
        return canFetchMonth() ? "is-neutral" : "is-unavailable";
    }
    function getFetchButtonTitle() {
        if (overlayState.fetchInProgress) {
            return "A fetch session is currently running.";
        }
        if (canFetchMonth()) {
            return "Fetch unsaved weekly ranges for this month.";
        }
        return "Open the Instagram likes page and let it load once so the extractor can capture a fresh request template.";
    }
    function createIconButton(title, iconSvg) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "insta-liked-overlay-icon-button";
        button.title = title;
        button.setAttribute("aria-label", title);
        button.appendChild(buildIconNode(iconSvg));
        return button;
    }
    function buildIconNode(svgMarkup) {
        const template = document.createElement("template");
        template.innerHTML = svgMarkup.trim();
        return template.content.firstElementChild;
    }
    function buildIconSvg(iconName) {
        if (iconName === "chevronLeft") {
            return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon">
        <path d="M15 18 9 12l6-6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
      </svg>
    `;
        }
        if (iconName === "chevronRight") {
            return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon">
        <path d="m9 18 6-6-6-6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
      </svg>
    `;
        }
        if (iconName === "chevronDown") {
            return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon">
        <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
      </svg>
    `;
        }
        if (iconName === "calendar") {
            return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon">
        <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>
        <path d="M16 3v4M8 3v4M3 10h18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
      </svg>
    `;
        }
        if (iconName === "check") {
            return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon">
        <path d="m5 12 4.2 4.2L19 6.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>
      </svg>
    `;
        }
        if (iconName === "spinner") {
            return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon insta-liked-overlay-icon-spinner">
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-opacity="0.28" stroke-width="2"/>
        <path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/>
      </svg>
    `;
        }
        if (iconName === "export") {
            return `
      <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon">
        <path d="M12 3v10m0-10 4 4m-4-4-4 4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
        <path d="M5 13v5a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
      </svg>
    `;
        }
        return `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="insta-liked-overlay-icon">
      <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/>
    </svg>
  `;
    }
    function getMonthSections() {
        return overlayState.activeMonthResults
            .map((result) => ({
            storageKey: getSectionStorageKey(result),
            startDate: String(result?.start_date || ""),
            endDate: String(result?.end_date || ""),
            items: normalizeResultItems(result)
        }))
            .filter((section) => section.items.length);
    }
    function getSectionStorageKey(result) {
        if (result?.start_date && result?.end_date) {
            return `instagram_liked_posts_${result.start_date}_to_${result.end_date}`;
        }
        return `instagram_liked_posts_${result?.year}_${String(result?.month || "").padStart(2, "0")}`;
    }
    function formatSectionDateLabel(sectionData) {
        return `${formatDayInMonth(sectionData.startDate)} to ${formatDayInMonth(sectionData.endDate)}`;
    }
    function getSavedCountForMonth(month) {
        return Number(overlayState.monthCountsByYear?.[month] || 0);
    }
    function formatDayInMonth(dateString) {
        const match = String(dateString || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) {
            return dateString || "Unknown";
        }
        return String(Number(match[3]));
    }
    function getSelectedMonthStorageKey() {
        return `${overlayState.selectedYear}-${String(overlayState.selectedMonth).padStart(2, "0")}`;
    }
    function captureOverlayScroll(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.id !== OVERLAY_PANEL_ID) {
            return;
        }
        overlayState.monthScrollTopByKey[getSelectedMonthStorageKey()] = target.scrollTop;
        persistOverlayState();
    }
    function restoreOverlayScroll(panel) {
        if (!(panel instanceof HTMLElement) || !overlayState.pendingScrollRestore) {
            return;
        }
        overlayState.pendingScrollRestore = false;
        const nextScrollTop = Number(overlayState.monthScrollTopByKey[getSelectedMonthStorageKey()] || 0);
        window.requestAnimationFrame(() => {
            panel.scrollTop = nextScrollTop;
        });
    }
    function formatLatestSummaryText(result) {
        if (!result) {
            return "None";
        }
        const label = result.start_date && result.end_date
            ? `${result.start_date} to ${result.end_date}`
            : `${result.year}-${String(result.month).padStart(2, "0")}`;
        return `${label} • ${result.count}`;
    }
    function formatDateParts(year, month, day) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    function delay(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }
    function findPointerDownUrlForCard(card) {
        for (const state of pointerDownState.values()) {
            if (state.card === card) {
                return state.url;
            }
        }
        return null;
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
    function installStyles() {
        if (document.getElementById("insta-liked-card-styles")) {
            return;
        }
        const style = document.createElement("style");
        style.id = "insta-liked-card-styles";
        style.textContent = `
    ${CARD_SELECTOR} {
      transition: opacity 120ms ease, filter 120ms ease, transform 120ms ease, box-shadow 120ms ease;
      will-change: opacity, transform, filter;
      cursor: pointer !important;
    }

    ${CARD_SELECTOR}:hover {
      opacity: 0.88;
      filter: brightness(1.08);
      transform: translateY(-1px);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
    }

    ${CARD_SELECTOR} [role="button"],
    ${CARD_SELECTOR} img {
      cursor: inherit !important;
    }

    ${CARD_SELECTOR}[${ACTIVE_PRESS_ATTR}="true"] {
      opacity: 0.8;
      filter: brightness(1.12);
      transform: scale(0.992);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.28);
    }

    #${OVERLAY_PANEL_ID} {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483645;
      width: min(420px, calc(100vw - 24px));
      min-width: 380px;
      min-height: 320px;
      max-height: calc(100vh - 24px);
      overflow: auto;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid #262626;
      background: #000;
      color: #f5f5f5;
      font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #${OVERLAY_TOGGLE_ID} {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483645;
      border: 1px solid #262626;
      border-radius: 8px;
      background: #000;
      color: #f5f5f5;
      padding: 8px 12px;
      font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      cursor: pointer;
    }

    .insta-liked-overlay-header {
      display: block;
      margin-bottom: 8px;
    }

    .insta-liked-overlay-top-controls {
      display: grid;
      grid-template-columns: 1fr auto auto 1fr;
      gap: 6px;
      align-items: center;
    }

    .insta-liked-overlay-top-controls button,
    .insta-liked-overlay-button {
      border: 1px solid #363636;
      border-radius: 6px;
      background: #121212;
      color: inherit;
      padding: 6px 8px;
      font: inherit;
    }

    .insta-liked-overlay-icon-button {
      cursor: pointer;
      width: 32px;
      height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      flex: 0 0 auto;
    }

    .insta-liked-overlay-icon {
      width: 16px;
      height: 16px;
    }

    .insta-liked-overlay-month-picker-shell {
      position: relative;
      grid-column: 2;
      justify-self: center;
    }

    .insta-liked-overlay-export-button {
      grid-column: 3;
      justify-self: start;
    }

    .insta-liked-overlay-month-trigger {
      height: 36px;
      min-width: 112px;
      max-width: 168px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      border: 1px solid #363636;
      border-radius: 10px;
      background: #121212;
      color: inherit;
      cursor: pointer;
      font: inherit;
    }

    .insta-liked-overlay-month-trigger.is-open {
      border-color: #5a5a5a;
      background: #181818;
    }

    .insta-liked-overlay-month-trigger-label,
    .insta-liked-overlay-month-trigger-meta {
      white-space: nowrap;
    }

    .insta-liked-overlay-month-trigger-label {
      font-weight: 600;
    }

    .insta-liked-overlay-month-trigger-meta {
      color: #8f8f8f;
      margin-left: 2px;
    }

    .insta-liked-overlay-header-fetch {
      grid-column: 1;
      justify-self: start;
      min-width: 104px;
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }

    .insta-liked-overlay-fetch-shell {
      position: relative;
      grid-column: 1;
      justify-self: start;
      display: inline-flex;
      align-items: stretch;
    }

    .insta-liked-overlay-fetch-menu-toggle {
      min-width: 34px;
      padding: 0 8px;
      border-left-width: 0;
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
    }

    .insta-liked-overlay-fetch-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 1;
      display: grid;
      min-width: 132px;
      padding: 6px;
      border: 1px solid #1f1f1f;
      border-radius: 10px;
      background: #080808;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.48);
    }

    .insta-liked-overlay-fetch-menu-item {
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      background: #121212;
      color: #f5f5f5;
      padding: 8px 10px;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }

    .insta-liked-overlay-header-close {
      grid-column: 4;
      justify-self: end;
    }

    .insta-liked-overlay-picker {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 1;
      display: grid;
      gap: 8px;
      border: 1px solid #1f1f1f;
      border-radius: 10px;
      padding: 8px;
      background: #080808;
      min-width: 210px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.48);
    }

    .insta-liked-overlay-year-row {
      display: grid;
      grid-template-columns: 32px 1fr 32px;
      gap: 8px;
      align-items: center;
    }

    .insta-liked-overlay-year-label {
      text-align: center;
      font-size: 13px;
      font-weight: 600;
    }

    .insta-liked-overlay-month-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .insta-liked-overlay-month-chip {
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      background: #121212;
      color: #a8a8a8;
      padding: 7px 8px;
      font: inherit;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      text-align: left;
    }

    .insta-liked-overlay-month-chip-label {
      font-weight: 600;
    }

    .insta-liked-overlay-month-chip-meta {
      font-size: 10px;
      color: #7f7f7f;
      margin-left: auto;
    }

    .insta-liked-overlay-month-chip.is-active {
      background: #f5f5f5;
      color: #000;
      border-color: #f5f5f5;
    }

    .insta-liked-overlay-month-chip.is-active .insta-liked-overlay-month-chip-meta {
      color: rgba(0, 0, 0, 0.6);
    }

    .insta-liked-overlay-month {
      display: grid;
      gap: 10px;
    }

    .insta-liked-overlay-month-body {
      display: grid;
      gap: 10px;
    }

    .insta-liked-overlay-month-toolbar {
      display: flex;
      justify-content: flex-start;
      gap: 8px;
      align-items: center;
    }

    .insta-liked-overlay-month-title-group {
      display: grid;
      gap: 2px;
    }

    .insta-liked-overlay-month-title {
      font-size: 13px;
      font-weight: 600;
    }

    .insta-liked-overlay-month-meta,
    .insta-liked-overlay-empty,
    .insta-liked-overlay-period-label {
      color: #a8a8a8;
      font-size: 11px;
    }

    .insta-liked-overlay-period {
      display: grid;
      gap: 6px;
    }

    .insta-liked-overlay-thumb-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      grid-auto-rows: 1fr;
      gap: 0;
      align-items: stretch;
    }

    .insta-liked-overlay-thumb {
      appearance: none;
      display: block;
      width: 100%;
      margin: 0;
      border: 1px solid #000;
      border-radius: 0;
      background: #121212;
      padding: 0;
      cursor: pointer;
      overflow: hidden;
      min-height: 100px;
      aspect-ratio: 1;
      line-height: 0;
      box-sizing: border-box;
    }

    .insta-liked-overlay-thumb:hover {
      filter: brightness(1.12);
    }

    .insta-liked-overlay-thumb.is-active {
      border-color: #f5f5f5;
      box-shadow: inset 0 0 0 1px #f5f5f5;
    }

    .insta-liked-overlay-thumb-image {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      background: #121212;
      vertical-align: top;
    }

    .insta-liked-overlay-button {
      cursor: pointer;
      min-width: 88px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-weight: 700;
    }

    .insta-liked-overlay-button.is-neutral {
      border-color: #363636;
      background: #121212;
      color: #f5f5f5;
    }

    .insta-liked-overlay-button.is-unavailable {
      border-color: #6b2424;
      background: #2a1111;
      color: #ffb0b0;
    }

    .insta-liked-overlay-button.is-busy {
      border-color: #5f5f5f;
      background: #1c1c1c;
      color: #f5f5f5;
    }

    .insta-liked-overlay-button:disabled {
      opacity: 1;
      cursor: default;
    }

    .insta-liked-overlay-progress {
      position: relative;
      overflow: hidden;
      border-radius: 9px;
      padding: 6px 8px;
      background: #121212;
      color: #f5f5f5;
    }

    .insta-liked-overlay-progress::before {
      content: "";
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.16) 50%, transparent 100%);
    }

    .insta-liked-overlay-progress.is-processing::before {
      animation: insta-liked-scan 1.6s ease-in-out infinite;
    }

    .insta-liked-overlay-progress-text {
      position: relative;
      z-index: 1;
    }

    .insta-liked-overlay-icon-spinner {
      animation: insta-liked-spin 1s linear infinite;
    }

    @keyframes insta-liked-scan {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(100%);
      }
    }

    @keyframes insta-liked-spin {
      100% {
        transform: rotate(360deg);
      }
    }
  `;
        (document.head || document.documentElement).appendChild(style);
    }
})();
