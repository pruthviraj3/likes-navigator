(function () {
  const PAGE_MESSAGE_TYPE = "INSTAGRAM_LIKED_PAYLOAD_CAPTURED";
  const PAGE_COMMAND_MESSAGE_TYPE = "INSTAGRAM_LIKED_EXTRACTOR_COMMAND";
  const PAGE_RESULT_MESSAGE_TYPE = "INSTAGRAM_LIKED_EXTRACTOR_RESULT";
  const PAGE_PROGRESS_MESSAGE_TYPE = "INSTAGRAM_LIKED_EXTRACTOR_PROGRESS";
  const LIKED_MEDIA_SCREEN_APP_ID = "com.instagram.privacy.activity_center.liked_media_screen";
  const LIKED_REFRESH_APP_ID = "com.instagram.privacy.activity_center.liked_refresh";
  const LIKED_NEXT_APP_ID = "com.instagram.privacy.activity_center.liked_next";
  const APP_IDS = new Set([
    LIKED_MEDIA_SCREEN_APP_ID,
    LIKED_REFRESH_APP_ID,
    LIKED_NEXT_APP_ID
  ]);
  const DEFAULT_X_IG_APP_ID = "936619743392459";

  if (window.__instaLikesBridgeInstalled) {
    return;
  }

  window.__instaLikesBridgeInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  const bridgeState = {
    templatesByAppId: new Map(),
    lastCapturedAt: null,
    extractionInFlight: false
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const message = event.data;
    if (!message || message.type !== PAGE_COMMAND_MESSAGE_TYPE) {
      return;
    }

    void handleCommand(message);
  });

  window.fetch = async function patchedFetch(input, init) {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : "";
    const requestBody = extractRequestBody(init?.body);
    const response = await originalFetch(input, init);

    if (!matchesLikedEndpoint(requestUrl)) {
      return response;
    }

    captureRequestTemplate(requestUrl, requestBody);

    try {
      const cloned = response.clone();
      const responseText = await cloned.text();
      publishCapturedPayload({
        requestUrl,
        requestBody,
        rawResponseText: responseText,
        transport: "fetch"
      });
    } catch (error) {
      console.error("[insta-likes-ext] failed to process fetch response", {
        requestUrl,
        error
      });
    }

    return response;
  };

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__instaLikesUrl = typeof url === "string" ? url : String(url || "");
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const requestUrl = this.__instaLikesUrl || "";
    if (matchesLikedEndpoint(requestUrl)) {
      const requestBody = extractRequestBody(body);
      captureRequestTemplate(requestUrl, requestBody);

      this.addEventListener("load", () => {
        try {
          publishCapturedPayload({
            requestUrl,
            requestBody,
            rawResponseText: String(this.responseText || ""),
            transport: "xhr"
          });
        } catch (error) {
          console.error("[insta-likes-ext] failed to process xhr response", {
            requestUrl,
            error
          });
        }
      });
    }

    return originalXHRSend.apply(this, arguments);
  };

  async function handleCommand(message) {
    const requestId = String(message.requestId || "");
    if (!requestId) {
      return;
    }

    try {
      if (message.action === "GET_STATUS") {
        const hasMediaScreenTemplate = bridgeState.templatesByAppId.has(LIKED_MEDIA_SCREEN_APP_ID);
        const hasRefreshTemplate = bridgeState.templatesByAppId.has(LIKED_REFRESH_APP_ID);
        const hasNextTemplate = bridgeState.templatesByAppId.has(LIKED_NEXT_APP_ID);
        respond(requestId, {
          ready: hasRefreshTemplate,
          hasMediaScreenTemplate,
          hasRefreshTemplate,
          hasNextTemplate,
          likesPage: location.pathname.startsWith("/your_activity/interactions/likes"),
          lastCapturedAt: bridgeState.lastCapturedAt,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        });
        return;
      }

      if (message.action === "EXTRACT_RANGE") {
        emitProgress(requestId, { stage: "started", action: "EXTRACT_RANGE" });
        const result = await extractLikedPostsForRange(message.payload || {}, (progress) =>
          emitProgress(requestId, progress)
        );
        emitProgress(requestId, {
          stage: "completed",
          action: "EXTRACT_RANGE",
          itemCount: result.count,
          pageCount: result.page_count
        });
        respond(requestId, result);
        return;
      }

      if (message.action === "NAVIGATE_TO_MEDIA") {
        const url = String(message.payload?.url || "");
        if (!url) {
          throw new Error("Missing media URL.");
        }

        respond(requestId, { accepted: true, url });
        window.setTimeout(() => {
          try {
            navigateToMedia(url);
          } catch (error) {
            console.error("[insta-likes-ext] media navigation failed", error);
            window.location.assign(url);
          }
        }, 0);
        return;
      }

      throw new Error(`Unsupported command: ${String(message.action || "")}`);
    } catch (error) {
      emitProgress(requestId, {
        stage: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      respondError(requestId, error);
    }
  }

  function respond(requestId, payload) {
    window.postMessage(
      {
        type: PAGE_RESULT_MESSAGE_TYPE,
        requestId,
        ok: true,
        payload
      },
      "*"
    );
  }

  function respondError(requestId, error) {
    window.postMessage(
      {
        type: PAGE_RESULT_MESSAGE_TYPE,
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      "*"
    );
  }

  function emitProgress(requestId, payload) {
    window.postMessage(
      {
        type: PAGE_PROGRESS_MESSAGE_TYPE,
        requestId,
        payload
      },
      "*"
    );
  }

  function matchesLikedEndpoint(urlString) {
    try {
      const url = new URL(urlString, window.location.origin);
      return (
        url.pathname === "/async/wbloks/fetch/" &&
        APP_IDS.has(url.searchParams.get("appid") || "")
      );
    } catch (_error) {
      return false;
    }
  }

  function captureRequestTemplate(requestUrl, requestBody) {
    try {
      const url = new URL(requestUrl, window.location.origin);
      const appId = url.searchParams.get("appid") || "";
      if (!APP_IDS.has(appId)) {
        return;
      }

      const formEntries = { ...requestBody };
      const paramsTemplate = parseParamsField(formEntries.params);
      delete formEntries.params;

      bridgeState.templatesByAppId.set(appId, {
        appId,
        urlBase: `${url.origin}${url.pathname}`,
        query: {
          appid: appId,
          type: url.searchParams.get("type") || "action",
          __bkv: url.searchParams.get("__bkv") || ""
        },
        formEntries,
        paramsTemplate,
        capturedAt: new Date().toISOString()
      });
      bridgeState.lastCapturedAt = new Date().toISOString();
    } catch (_error) {
      // Ignore malformed template captures.
    }
  }

  function simplifyEndpoint(urlString) {
    try {
      const url = new URL(urlString, window.location.origin);
      return url.searchParams.get("appid") || url.pathname;
    } catch (_error) {
      return urlString;
    }
  }

  function navigateToMedia(urlString) {
    const targetUrl = new URL(urlString, window.location.origin);
    if (targetUrl.origin !== window.location.origin) {
      window.location.assign(targetUrl.toString());
      return;
    }

    if (normalizePath(targetUrl.pathname) === normalizePath(window.location.pathname)) {
      return;
    }

    const targetHref = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
    window.history.pushState(null, "", targetHref);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));

    window.setTimeout(() => {
      if (normalizePath(window.location.pathname) !== normalizePath(targetUrl.pathname)) {
        window.location.assign(targetUrl.toString());
      }
    }, 400);
  }

  function normalizePath(pathname) {
    return String(pathname || "").replace(/\/?$/, "/");
  }

  function publishCapturedPayload({ requestUrl, requestBody, rawResponseText, transport }) {
    const payload = parseIgJson(rawResponseText);
    const extractedItems = extractMediaItems(rawResponseText);
    const mediaItems =
      extractedItems.length > 0 ? extractedItems : extractMediaItemsFromParsedPayload(payload);

    window.postMessage(
      {
        type: PAGE_MESSAGE_TYPE,
        payload: {
          request: {
            endpoint: simplifyEndpoint(requestUrl),
            cursor: requestBody.cursor || null,
            pageSize: requestBody.page_size || null,
            transport
          },
          items: mediaItems.map(toCapturedCacheItem)
        }
      },
      "*"
    );
  }

  function toCapturedCacheItem(item) {
    return {
      mediaId: item.media_id,
      mediaCode: item.media_code,
      mediaImageUrl: item.media_image_url,
      canonicalUrl: `https://www.instagram.com/p/${item.media_code}/`,
      mediaProductType: item.media_product_type,
      mediaType: item.media_type,
      locationName: item.location_name,
      icon: item.icon,
      imageKeys: extractImageKeys(item.media_image_url),
      capturedAt: new Date().toISOString()
    };
  }

  function parseIgJson(text) {
    const raw = String(text || "").trim();
    const normalized = raw.replace(/^\uFEFF?for\s*\(\s*;\s*;\s*\);\s*/, "");
    if (normalized.startsWith("<")) {
      const preview = normalized.slice(0, 120).replace(/\s+/g, " ");
      throw new Error(`Instagram returned non-JSON content: ${preview}`);
    }

    return JSON.parse(normalized);
  }

  function extractMediaItems(rawText) {
    const items = [];
    const seen = new Set();
    const blockRegex =
      /\(bk\.action\.map\.Make,\s*\(bk\.action\.array\.Make,\s*"media_id",\s*"media_code",\s*"media_product_type",\s*"media_type",\s*"media_image_url",\s*"location_name",\s*"icon",\s*"margin_right"\),\s*\(bk\.action\.array\.Make,\s*"([^"]*)",\s*"([^"]*)",\s*"([^"]*)",\s*\(bk\.action\.i32\.Const,\s*(\d+)\),\s*"((?:\\.|[^"\\])*)",\s*"((?:\\.|[^"\\])*)",\s*"([^"]*)",\s*"([^"]*)"\)\)/g;
    const fallbackTupleRegex =
      /\(bk\.action\.array\.Make,\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*\(bk\.action\.i32\.Const,\s*(\d+)\),\s*"((?:\\.|[^"\\])*)",\s*"((?:\\.|[^"\\])*)",\s*"([^"]*)",\s*"([^"]*)"\)/g;

    for (const match of String(rawText || "").matchAll(blockRegex)) {
      const item = matchToMediaItem(match);
      if (!item || seen.has(item.media_id)) {
        continue;
      }

      seen.add(item.media_id);
      items.push(item);
    }

    if (items.length > 0) {
      return items;
    }

    for (const match of decodeBloksEscapes(String(rawText || "")).matchAll(fallbackTupleRegex)) {
      const item = matchToMediaItem(match);
      if (!item || seen.has(item.media_id)) {
        continue;
      }

      seen.add(item.media_id);
      items.push(item);
    }

    return items;
  }

  function matchToMediaItem(match) {
    const [
      ,
      mediaId,
      mediaCode,
      mediaProductType,
      mediaTypeRaw,
      mediaImageUrlRaw,
      locationNameRaw,
      icon
    ] = match;

    if (!mediaId || !mediaCode) {
      return null;
    }

    return {
      media_id: mediaId,
      media_code: mediaCode,
      url: `https://www.instagram.com/p/${mediaCode}`,
      media_product_type: mediaProductType,
      media_type: Number(mediaTypeRaw),
      media_image_url: unescapeBloksString(mediaImageUrlRaw),
      location_name: unescapeBloksString(locationNameRaw),
      icon
    };
  }

  function extractMediaItemsFromParsedPayload(root) {
    const items = [];
    const seen = new Set();

    walk(root, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
      }

      const mediaId = stringOrEmpty(value.media_id);
      const mediaCode = stringOrEmpty(value.media_code);
      if (!mediaId || !mediaCode || seen.has(mediaId)) {
        return;
      }

      const mediaImageUrl = stringOrEmpty(value.media_image_url);
      if (!mediaImageUrl) {
        return;
      }

      seen.add(mediaId);
      items.push({
        media_id: mediaId,
        media_code: mediaCode,
        url: `https://www.instagram.com/p/${mediaCode}`,
        media_product_type: stringOrEmpty(value.media_product_type),
        media_type: typeof value.media_type === "number" ? value.media_type : 0,
        media_image_url: mediaImageUrl,
        location_name: stringOrEmpty(value.location_name),
        icon: stringOrEmpty(value.icon)
      });
    });

    return items;
  }

  function extractNextPageInfo(rawText) {
    return (
      extractNextPageInfoFromManifest(rawText) ||
      extractNextPageInfoDirect(rawText) ||
      extractNextPageInfoHeuristic(rawText)
    );
  }

  function extractNextPageInfoFromManifest(rawText) {
    const source = String(rawText || "");
    const markers = [
      'AsyncActionWithDataManifest, "com.instagram.privacy.activity_center.liked_next"',
      'AsyncActionWithDataManifest, \\"com.instagram.privacy.activity_center.liked_next\\"'
    ];

    for (const marker of markers) {
      const markerIndex = source.indexOf(marker);
      if (markerIndex === -1) {
        continue;
      }

      const argsStart = source.indexOf('(bk.action.array.Make, "page_size", "activity_center_params", "cursor", "container_id", "element_id"), (bk.action.array.Make, ', markerIndex);
      const escapedArgsStart = source.indexOf('(bk.action.array.Make, \\"page_size\\", \\"activity_center_params\\", \\"cursor\\", \\"container_id\\", \\"element_id\\"), (bk.action.array.Make, ', markerIndex);
      const startIndex = argsStart !== -1 ? argsStart : escapedArgsStart;
      if (startIndex === -1) {
        continue;
      }

      const labelArraySuffix =
        argsStart !== -1
          ? '(bk.action.array.Make, "page_size", "activity_center_params", "cursor", "container_id", "element_id"), '
          : '(bk.action.array.Make, \\"page_size\\", \\"activity_center_params\\", \\"cursor\\", \\"container_id\\", \\"element_id\\"), ';
      const valueArrayStart = startIndex + labelArraySuffix.length;

      if (
        !source.startsWith("(bk.action.array.Make, ", valueArrayStart)
      ) {
        continue;
      }

      const parsedValues = parseManifestValueArray(source, valueArrayStart);
      if (!parsedValues || parsedValues.length < 5) {
        continue;
      }

      return {
        page_size: parsedValues[0],
        activity_center_params: parsedValues[1],
        cursor: parsedValues[2],
        container_id: parsedValues[3],
        element_id: parsedValues[4]
      };
    }

    return null;
  }

  function parseManifestValueArray(source, arrayStartIndex) {
    const prefix = "(bk.action.array.Make, ";
    if (!source.startsWith(prefix, arrayStartIndex)) {
      return null;
    }

    let index = arrayStartIndex + prefix.length;
    const values = [];

    while (index < source.length && values.length < 5) {
      while (/\s|,/.test(source[index] || "")) {
        index += 1;
      }

      if (source[index] !== '"') {
        return null;
      }

      const parsed = readQuotedString(source, index);
      if (!parsed) {
        return null;
      }

      values.push(unescapeBloksString(parsed.value));
      index = parsed.endIndex;
    }

    return values.length === 5 ? values : null;
  }

  function readQuotedString(source, startIndex) {
    if (source[startIndex] !== '"') {
      return null;
    }

    let index = startIndex + 1;
    let value = "";

    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        if (index + 1 >= source.length) {
          return null;
        }

        value += char + source[index + 1];
        index += 2;
        continue;
      }

      if (char === '"') {
        return {
          value,
          endIndex: index + 1
        };
      }

      value += char;
      index += 1;
    }

    return null;
  }

  function extractNextPageInfoDirect(rawText) {
    const regex =
      /AsyncActionWithDataManifest,\s*\\?"com\.instagram\.privacy\.activity_center\.liked_next\\?".*?\(bk\.action\.array\.Make,\s*\\?"(\d+)\\?",\s*\\?"((?:\\.|[^"\\])*ActivityCenterParams(?:\\.|[^"\\])*)\\?",\s*\\?"(QVF[A-Za-z0-9+/=_-]+)\\?",\s*\\?"(\d+)\\?",\s*\\?"(\d+)\\?"/s;
    const match = String(rawText || "").match(regex);
    if (!match) {
      return null;
    }

    return {
      page_size: unescapeBloksString(match[1]),
      activity_center_params: unescapeBloksString(match[2]),
      cursor: unescapeBloksString(match[3]),
      container_id: unescapeBloksString(match[4]),
      element_id: unescapeBloksString(match[5])
    };
  }

  function extractNextPageInfoHeuristic(rawText) {
    const candidates = [
      'AsyncActionWithDataManifest, \\"com.instagram.privacy.activity_center.liked_next\\"',
      'AsyncActionWithDataManifest, "com.instagram.privacy.activity_center.liked_next"'
    ];

    for (const marker of candidates) {
      const index = String(rawText || "").indexOf(marker);
      if (index === -1) {
        continue;
      }

      const chunk = String(rawText || "").slice(index, index + 12000);
      const quoted = [...chunk.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
        unescapeBloksString(match[1])
      );
      const cursors = quoted.filter((value) => /^QVF[A-Za-z0-9+/=_-]{20,}$/.test(value));
      const numericIds = quoted.filter((value) => /^\d{8,}$/.test(value));
      const activityCenterParams = quoted.find((value) =>
        value.includes("ActivityCenterParams")
      );
      const pageSize = quoted.find((value) => /^\d+$/.test(value)) || "9";

      if (!activityCenterParams || cursors.length === 0 || numericIds.length < 2) {
        continue;
      }

      return {
        page_size: pageSize,
        activity_center_params: activityCenterParams,
        cursor: cursors[cursors.length - 1],
        container_id: numericIds[numericIds.length - 2],
        element_id: numericIds[numericIds.length - 1]
      };
    }

    return null;
  }

  function buildRefreshParams({ rangeStartUnix, rangeEndUnix, sort, refreshTemplate }) {
    const base = cloneJson(refreshTemplate?.paramsTemplate || {});

    return {
      ...base,
      content_container_id: base.content_container_id,
      content_element_id: base.content_element_id,
      content_spinner_id: base.content_spinner_id,
      main_order_state_value: false,
      main_attribute_order_state_value: buildSortStateValue(
        sort,
        base.main_attribute_order_state_value
      ),
      main_date_start_state_value: rangeStartUnix,
      main_date_end_state_value: rangeEndUnix,
      main_authors_state_value: stringOrEmpty(base.main_authors_state_value),
      main_filter_to_visible_on_facebook_value: Boolean(
        base.main_filter_to_visible_on_facebook_value ?? false
      ),
      main_includes_location_value: Boolean(base.main_includes_location_value ?? false),
      main_liked_privately_value: Boolean(base.main_liked_privately_value ?? false),
      main_content_type_value: Number.isFinite(base.main_content_type_value)
        ? base.main_content_type_value
        : 0,
      main_content_types_value: stringOrEmpty(base.main_content_types_value) || "Posts, Reels",
      main_account_history_events_state_value: stringOrEmpty(
        base.main_account_history_events_state_value
      ),
      entrypoint: stringOrEmpty(base.entrypoint),
      shared_user_id: base.shared_user_id == null ? "" : String(base.shared_user_id),
      main_filter_to_visible_from_facebook_value: Boolean(
        base.main_filter_to_visible_from_facebook_value ?? false
      )
    };
  }

  function buildSortStateValue(sort, existingValue) {
    if (typeof existingValue === "string" && existingValue) {
      return sort;
    }

    if (existingValue && typeof existingValue === "object" && !Array.isArray(existingValue)) {
      const cloned = cloneJson(existingValue);
      const tuple = cloned?.["py/reduce"]?.[1]?.["py/tuple"];
      if (Array.isArray(tuple) && tuple.length > 0) {
        tuple[0] = sort;
        return cloned;
      }
    }

    return {
      "py/reduce": [
        {
          "py/type":
            "bloks.apps.instagram.privacy.activity_center.general_constants.ActivityCenterSortAndFilterConstants"
        },
        {
          "py/tuple": [sort]
        }
      ]
    };
  }

  function buildNextParams(nextPageInfo, paginationState) {
    const parsedManifestParams = parseActivityCenterParamsJson(
      String(nextPageInfo.activity_center_params || "")
    );
    const stableFilterState = cloneJson(paginationState?.stableFilterState || {});
    const latestKnownState = cloneJson(paginationState?.latestKnownState || {});
    const merged = {
      ...latestKnownState,
      ...(parsedManifestParams || {})
    };

    // Keep the selected filter state pinned across pagination.
    merged.main_order_state_value = stableFilterState.main_order_state_value;
    merged.main_date_start_state_value = stableFilterState.main_date_start_state_value;
    merged.main_date_end_state_value = stableFilterState.main_date_end_state_value;
    merged.main_content_type_value = stableFilterState.main_content_type_value;
    merged.main_content_types_value = stableFilterState.main_content_types_value;
    merged.main_filter_to_visible_on_facebook_value =
      stableFilterState.main_filter_to_visible_on_facebook_value;
    merged.main_filter_to_visible_from_facebook_value =
      stableFilterState.main_filter_to_visible_from_facebook_value;
    merged.main_includes_location_value = stableFilterState.main_includes_location_value;
    merged.main_liked_privately_value = stableFilterState.main_liked_privately_value;
    merged.main_authors_state_value = stableFilterState.main_authors_state_value;
    merged.main_account_history_events_state_value =
      stableFilterState.main_account_history_events_state_value;
    merged.main_attribute_order_state_value =
      stableFilterState.main_attribute_order_state_value;

    const cursor = String(nextPageInfo.cursor || "");
    merged.initial_cursor = cursor;

    const containerId = String(nextPageInfo.container_id || "");
    const elementId = String(nextPageInfo.element_id || "");
    merged.content_container_id = pickNumericId(
      parsedManifestParams?.content_container_id,
      latestKnownState.content_container_id,
      stableFilterState.content_container_id,
      containerId
    );
    merged.content_element_id = pickNumericId(
      parsedManifestParams?.content_element_id,
      latestKnownState.content_element_id,
      stableFilterState.content_element_id,
      elementId
    );
    merged.content_spinner_id = pickNumericId(
      parsedManifestParams?.content_spinner_id,
      latestKnownState.content_spinner_id,
      stableFilterState.content_spinner_id
    );

    paginationState.latestKnownState = cloneJson(merged);

    return {
      page_size: String(nextPageInfo.page_size || "9"),
      activity_center_params: JSON.stringify(merged),
      cursor,
      container_id: containerId,
      element_id: elementId
    };
  }

  function buildNextParamsFromManifest(nextPageInfo, paginationState) {
    const params = buildNextParams(nextPageInfo, paginationState);

    if (
      !params.page_size ||
      !params.activity_center_params ||
      !params.cursor ||
      !params.container_id ||
      !params.element_id
    ) {
      throw new Error("Instagram liked_next manifest was incomplete.");
    }

    validateNextParams(params);
    return params;
  }

  function buildFormBodyFromCapturedTemplate(template, paramsPayload, reqToken) {
    const form = new URLSearchParams();

    for (const [key, value] of Object.entries(template?.formEntries || {})) {
      if (key === "params" || value == null) {
        continue;
      }

      form.set(key, String(value));
    }

    if (reqToken) {
      form.set("__req", reqToken);
    }

    form.set("params", JSON.stringify(paramsPayload));
    return form.toString();
  }

  async function extractLikedPostsForRange(opts, onProgress = null) {
    if (bridgeState.extractionInFlight) {
      throw new Error("An Instagram liked-post extraction is already running.");
    }

    bridgeState.extractionInFlight = true;

    try {
      const maxPages = Math.max(1, Math.min(Number(opts.maxPages || 100), 100));
      const sort =
        opts.sort === "newest_to_oldest" ? "newest_to_oldest" : "oldest_to_newest";
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const year = Number(opts.year);
      const month = Number(opts.month);
      const label = String(opts.label || "range");
      const startDate = opts.startDate ? String(opts.startDate) : null;
      const endDate = opts.endDate ? String(opts.endDate) : null;
      const explicitRangeStartUnix = Number(opts.rangeStartUnix);
      const explicitRangeEndUnix = Number(opts.rangeEndUnix);
      const derivedRange =
        startDate && endDate
          ? dateRangeUnix(startDate, endDate, timeZone)
          : {
              start: explicitRangeStartUnix,
              end: explicitRangeEndUnix
            };
      const rangeStartUnix = Number(derivedRange.start);
      const rangeEndUnix = Number(derivedRange.end);

      if (!Number.isFinite(rangeStartUnix) || !Number.isFinite(rangeEndUnix)) {
        throw new Error("The requested date range was invalid.");
      }

      if (rangeStartUnix > rangeEndUnix) {
        throw new Error("The requested start date must be before the end date.");
      }

      const initialTemplate = resolveInitialTemplate();
      if (!initialTemplate) {
        throw new Error(
          "No Instagram liked-request template is available yet. Open the Likes activity page and wait for it to load once."
        );
      }

      const nextTemplate = resolveTemplate(LIKED_NEXT_APP_ID, initialTemplate);
      const refreshParams = buildRefreshParams({
        rangeStartUnix,
        rangeEndUnix,
        sort,
        refreshTemplate: initialTemplate
      });
      validateRefreshParams(refreshParams);
      const seenMediaIds = new Set();
      const seenCursors = new Set();
      const allItems = [];
      const paginationDebug = [];
      const stableFilterState = cloneJson(refreshParams);
      const paginationState = {
        stableFilterState,
        latestKnownState: cloneJson(refreshParams)
      };
      let pageCount = 0;
      let reqToken = incrementRequestToken(initialTemplate.formEntries.__req || "0");

      const firstPageText = await postInitialExtractorRequest({
        initialTemplate,
        paramsPayload: refreshParams,
        reqToken
      });

      pageCount += 1;
      pushUniqueItems(allItems, seenMediaIds, extractMediaItems(firstPageText));
      reportExtractionProgress(onProgress, {
        stage: "page",
        pageCount,
        itemCount: allItems.length
      });
      let nextPageInfo = extractNextPageInfo(firstPageText);

      while (nextPageInfo && pageCount < maxPages) {
        if (!nextPageInfo.cursor || seenCursors.has(nextPageInfo.cursor)) {
          break;
        }

        paginationDebug.push({
          page: pageCount + 1,
          cursor: nextPageInfo.cursor,
          container_id: nextPageInfo.container_id,
          element_id: nextPageInfo.element_id,
          activity_center_params_preview: String(nextPageInfo.activity_center_params || "").slice(0, 160)
        });

        seenCursors.add(nextPageInfo.cursor);
        reqToken = incrementRequestToken(reqToken);
        await delay(700 + Math.floor(Math.random() * 500));

        const nextPageText = await postExtractorRequest({
          template: nextTemplate,
          paramsPayload: buildNextParamsFromManifest(nextPageInfo, paginationState),
          reqToken
        });

        pageCount += 1;
        pushUniqueItems(allItems, seenMediaIds, extractMediaItems(nextPageText));
        reportExtractionProgress(onProgress, {
          stage: "page",
          pageCount,
          itemCount: allItems.length
        });

        nextPageInfo = extractNextPageInfo(nextPageText);
      }

      return {
        source: "instagram_activity_center_likes",
        year: Number.isInteger(year) ? year : null,
        month: Number.isInteger(month) ? month : null,
        label,
        start_date: startDate,
        end_date: endDate,
        sort,
        time_zone: timeZone,
        request_date_range: {
          start_unix: refreshParams.main_date_start_state_value,
          end_unix: refreshParams.main_date_end_state_value
        },
        pagination_debug: paginationDebug,
        extracted_at: new Date().toISOString(),
        page_count: pageCount,
        count: allItems.length,
        items: allItems
      };
    } finally {
      bridgeState.extractionInFlight = false;
    }
  }

  function resolveTemplate(appId, fallbackTemplate) {
    const exactTemplate = bridgeState.templatesByAppId.get(appId);
    if (exactTemplate) {
      return exactTemplate;
    }

    if (fallbackTemplate) {
      return deriveTemplate(fallbackTemplate, appId);
    }

    if (appId === LIKED_REFRESH_APP_ID) {
      return (
        deriveTemplate(bridgeState.templatesByAppId.get(LIKED_MEDIA_SCREEN_APP_ID), appId) ||
        deriveTemplate(bridgeState.templatesByAppId.get(LIKED_NEXT_APP_ID), appId)
      );
    }

    if (appId === LIKED_NEXT_APP_ID) {
      return (
        deriveTemplate(bridgeState.templatesByAppId.get(LIKED_REFRESH_APP_ID), appId) ||
        deriveTemplate(bridgeState.templatesByAppId.get(LIKED_MEDIA_SCREEN_APP_ID), appId)
      );
    }

    return null;
  }

  function resolveInitialTemplate() {
    return bridgeState.templatesByAppId.get(LIKED_REFRESH_APP_ID) || null;
  }

  function deriveTemplate(template, appId) {
    if (!template) {
      return null;
    }

    return {
      ...template,
      appId,
      query: {
        ...template.query,
        appid: appId
      }
    };
  }

  async function postExtractorRequest({ template, paramsPayload, reqToken }) {
    const headers = {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-ig-app-id": DEFAULT_X_IG_APP_ID,
      "x-requested-with": "XMLHttpRequest"
    };
    const csrfToken = getCookie("csrftoken");
    if (csrfToken) {
      headers["x-csrftoken"] = csrfToken;
    }

    const response = await originalFetch(buildEndpointUrl(template), {
      method: "POST",
      credentials: "include",
      headers,
      body: buildFormBodyFromCapturedTemplate(template, paramsPayload, reqToken)
    });

    if (response.status === 429) {
      await delay(2000);
      throw new Error("Instagram rate-limited the extractor with HTTP 429.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Instagram rejected the extractor request with HTTP ${response.status}.`);
    }

    const responseUrl = new URL(response.url || buildEndpointUrl(template), window.location.origin);
    if (response.redirected || responseUrl.pathname.startsWith("/accounts/login")) {
      throw new Error("Instagram redirected the extractor to login.");
    }

    const text = await response.text();
    parseIgJson(text);
    return text;
  }

  async function postInitialExtractorRequest({ initialTemplate, paramsPayload, reqToken }) {
    try {
      return await postExtractorRequest({
        template: initialTemplate,
        paramsPayload,
        reqToken
      });
    } catch (error) {
      throw new Error(
        `Initial liked-post request failed via ${initialTemplate?.appId || "unknown"}. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function buildEndpointUrl(template) {
    const url = new URL(template.urlBase);
    url.searchParams.set("appid", template.query.appid);
    url.searchParams.set("type", template.query.type || "action");

    if (template.query.__bkv) {
      url.searchParams.set("__bkv", template.query.__bkv);
    }

    return url.toString();
  }

  function pushUniqueItems(target, seenMediaIds, incomingItems) {
    for (const item of incomingItems) {
      if (!item?.media_id || seenMediaIds.has(item.media_id)) {
        continue;
      }

      seenMediaIds.add(item.media_id);
      target.push(item);
    }
  }

  function dateRangeUnix(startDate, endDate, timeZone) {
    const start = parseDateParts(startDate);
    const end = parseDateParts(endDate);
    if (!start || !end) {
      throw new Error("Dates must use YYYY-MM-DD format.");
    }

    return {
      start: zonedMidnightToUnixSeconds(start.year, start.month, start.day, timeZone),
      end: zonedMidnightToUnixSeconds(end.year, end.month, end.day, timeZone)
    };
  }

  function parseDateParts(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      return null;
    }

    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    };
  }

  function zonedMidnightToUnixSeconds(year, month1, day, timeZone) {
    let utcGuess = Date.UTC(year, month1 - 1, day, 0, 0, 0);

    for (let index = 0; index < 2; index += 1) {
      const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, new Date(utcGuess));
      utcGuess = Date.UTC(year, month1 - 1, day, 0, 0, 0) - offsetMinutes * 60 * 1000;
    }

    return Math.floor(utcGuess / 1000);
  }

  function getTimeZoneOffsetMinutes(timeZone, date) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const zonePart = formatter.formatToParts(date).find((part) => part.type === "timeZoneName");
    const value = zonePart?.value || "GMT+0";
    const match = value.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
    if (!match) {
      return 0;
    }

    const sign = Number(match[1]) < 0 ? -1 : 1;
    const hours = Math.abs(Number(match[1]));
    const minutes = Number(match[2] || "0");
    return sign * (hours * 60 + minutes);
  }

  function incrementRequestToken(token) {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    const normalized = String(token || "0").toLowerCase();
    let carry = 1;
    let output = "";

    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const currentIndex = alphabet.indexOf(normalized[index]);
      if (currentIndex === -1) {
        return normalized;
      }

      let nextIndex = currentIndex + carry;
      if (nextIndex >= alphabet.length) {
        nextIndex -= alphabet.length;
        carry = 1;
      } else {
        carry = 0;
      }

      output = alphabet[nextIndex] + output;
    }

    return carry ? `1${output}` : output;
  }

  function parseParamsField(value) {
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function extractRequestBody(body) {
    if (typeof body === "string") {
      return Object.fromEntries(new URLSearchParams(body).entries());
    }

    if (body instanceof URLSearchParams) {
      return Object.fromEntries(body.entries());
    }

    return {};
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
    } catch (_error) {
      if (urlString) {
        keys.add(`raw:${urlString}`);
      }
    }

    return [...keys];
  }

  function getCookie(name) {
    return document.cookie
      .split("; ")
      .find((row) => row.startsWith(`${name}=`))
      ?.split("=")
      .slice(1)
      .join("=") || "";
  }

  function walk(value, visit, seen = new WeakSet()) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }

    seen.add(value);
    visit(value);

    if (Array.isArray(value)) {
      for (const nested of value) {
        walk(nested, visit, seen);
      }
      return;
    }

    for (const nested of Object.values(value)) {
      walk(nested, visit, seen);
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeActivityCenterParams(value) {
    let current = String(value || "").trim();
    if (!current) {
      return current;
    }

    for (let index = 0; index < 3; index += 1) {
      const decoded = decodeBloksString(current);
      if (looksLikeActivityCenterParamsJson(decoded)) {
        return compactJsonString(decoded);
      }

      if (looksLikeActivityCenterParamsJson(current)) {
        return compactJsonString(current);
      }

      if (decoded === current) {
        break;
      }

      current = decoded;
    }

    return current;
  }

  function looksLikeActivityCenterParamsJson(value) {
    const trimmed = String(value || "").trim();
    return trimmed.startsWith("{") && trimmed.includes('"py/object"');
  }

  function compactJsonString(value) {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch (_error) {
      return value;
    }
  }

  function parseActivityCenterParamsJson(value) {
    const normalized = normalizeActivityCenterParams(value);
    if (!looksLikeActivityCenterParamsJson(normalized)) {
      return null;
    }

    try {
      return JSON.parse(normalized);
    } catch (_error) {
      return null;
    }
  }

  function pickNumericId(...values) {
    for (const value of values) {
      const normalized = Number(value);
      if (Number.isFinite(normalized) && normalized > 0) {
        return normalized;
      }
    }

    return null;
  }

  function validateRefreshParams(params) {
    if (
      !Number.isFinite(Number(params.content_container_id)) ||
      !Number.isFinite(Number(params.content_element_id)) ||
      !Number.isFinite(Number(params.content_spinner_id))
    ) {
      throw new Error(
        "No valid liked_refresh template is captured yet. Open the Likes page, change or apply filters once, and try again."
      );
    }
  }

  function validateNextParams(params) {
    let parsed;
    try {
      parsed = JSON.parse(params.activity_center_params);
    } catch (_error) {
      throw new Error(
        `Instagram liked_next activity_center_params is not valid JSON. Preview: ${params.activity_center_params.slice(0, 160)}`
      );
    }

    if (
      parsed["py/object"] !==
      "bloks.apps.instagram.privacy.activity_center.data_types.ActivityCenterParams"
    ) {
      throw new Error("Instagram liked_next activity_center_params had an unexpected py/object.");
    }

    if (!/^\d+$/.test(params.container_id) || !/^\d+$/.test(params.element_id)) {
      throw new Error("Instagram liked_next manifest returned non-numeric container or element ids.");
    }

    if (!/^QVF[A-Za-z0-9+/=_-]+$/.test(params.cursor)) {
      throw new Error("Instagram liked_next manifest returned an unexpected cursor format.");
    }
  }

  function stringOrEmpty(value) {
    return typeof value === "string" ? value : "";
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function reportExtractionProgress(onProgress, payload) {
    if (typeof onProgress === "function") {
      onProgress(payload);
    }
  }

  function unescapeBloksString(value) {
    return String(value || "")
      .replaceAll("\\/", "/")
      .replaceAll("\\u00253D", "%3D")
      .replaceAll("\\u0025", "%")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      )
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  function decodeBloksString(value) {
    return String(value || "")
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
  }

  function decodeBloksEscapes(text) {
    return String(text || "")
      .replace(/\\\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      )
      .replace(/\\\\\//g, "/")
      .replace(/\\"/g, '"');
  }
})();
