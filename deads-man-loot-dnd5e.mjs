// ============================================================
// Dead's Man Loot — адаптер D&D 5e
// ============================================================
// Вся механика лута живёт в базовом модуле deads-man-loot (globalThis.deadsManLoot).
// Здесь: системно-зависимые значения D&D 5e + слой прав доступа через ГМа
// (временный LIMITED на время открытого окна) и кэш добычи для игроков,
// у которых предмета нет локально.
// ============================================================

const MODULE_ID = "deads-man-loot-dnd5e";
const BASE_ID = "deads-man-loot";
const DEBUG = true;

function log(...args) {
  if (DEBUG) console.log(`[${MODULE_ID}]`, ...args);
}

function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

function base() {
  return globalThis.deadsManLoot ?? null;
}

// Синхронный разбор uuid (токена или актёра) — для проверок в обработчике клика.
function resolveSync(uuid) {
  if (!uuid) return null;
  try { return foundry.utils.fromUuidSync?.(uuid) ?? globalThis.fromUuidSync?.(uuid) ?? null; }
  catch { return null; }
}

// Тело для проверки мёртвости: сначала токен (у него могут быть посмертные статусы),
// затем актёр из локальной базы.
function corpsePair(actorId, actorUuid, tokenUuid) {
  const doc = resolveSync(tokenUuid);
  let actor = doc?.actor ?? null;
  if (!actor && actorId) actor = game.actors.get(actorId) ?? null;
  if (!actor && actorUuid) actor = resolveSync(actorUuid);
  return { doc, actor };
}

// Кэш добычи для игроков: actorId -> { items, actorUuid, tokenUuid, actorName }
const lootDataCache = new Map();

// Счётчик открытых окон по паре `${actorId}:${userId}` -> { prev, count }
const tempLootPerms = new Map();

// ============================================================
// СТАТУСЫ: «КРОВОТОЧИТ» / «МЁРТВ» / 0 ХП
// ============================================================
function hasBloodiedStatus(actor) {
  if (typeof actor.hasStatusEffect === "function") {
    try { if (actor.hasStatusEffect("bloodied")) return true; } catch { /* не готово */ }
  }
  if (actor.effects?.some?.(e => {
    if (e.statuses?.has?.("bloodied")) return true;
    if (e.statuses?.has?.("Кровоточит")) return true;
    if (e.name === "Кровоточит" || e.name === "Bloodied") return true;
    return false;
  })) return true;
  if (actor.statuses?.has?.("bloodied")) return true;
  if (actor.statuses?.has?.("Кровоточит")) return true;
  return false;
}

function hasDeadStatus(actor) {
  if (typeof actor.hasStatusEffect === "function") {
    try { if (actor.hasStatusEffect("dead")) return true; } catch { /* не готово */ }
  }
  if (actor.effects?.some?.(e => e.statuses?.has?.("dead"))) return true;
  if (actor.statuses?.has?.("dead")) return true;
  return false;
}

// Статусы «труп», которые ГМ мог повесить прямо на ТОКЕН, а не на актёра.
const CORPSE_STATUS_IDS = ["dead", "bloodied", "Кровоточит"];

function tokenShowsCorpseStatus(tokenDocument) {
  if (!tokenDocument) return false;
  if (typeof tokenDocument.hasStatusEffect === "function") {
    for (const statusId of CORPSE_STATUS_IDS) {
      try { if (tokenDocument.hasStatusEffect(statusId)) return true; } catch { /* не готово */ }
    }
  }
  // v14: TokenDocument#effects = статусные эффекты + overlayEffect токена
  const effects = tokenDocument.effects ?? tokenDocument.statusEffects ?? [];
  for (const effect of effects) {
    const statuses = effect?.statuses;
    if (!statuses) continue;
    for (const statusId of CORPSE_STATUS_IDS) {
      try {
        if (statuses.has?.(statusId) === true || statuses.includes?.(statusId) === true) return true;
      } catch { /* не готово */ }
    }
  }
  return false;
}

// tokenDocument — необязательный параметр: учитывает посмертные статусы самого токена.
function isDeadOrZeroHp(actor, tokenDocument = null) {
  if (!actor) return tokenShowsCorpseStatus(tokenDocument);
  if (hasBloodiedStatus(actor)) return true;
  if (hasDeadStatus(actor)) return true;
  if (actor.isDead === true) return true;
  if (tokenShowsCorpseStatus(tokenDocument)) return true;
  const hpRaw = actor.system?.attributes?.hp?.value;
  if (hpRaw !== undefined && hpRaw !== null) {
    const hp = Number(hpRaw);
    if (Number.isFinite(hp) && hp <= 0) return true;
  }
  return false;
}

// ============================================================
// ПРАВА ДОСТУПА: временный LIMITED на время открытого окна
// ============================================================
function ownershipLevels() {
  return CONST.DOCUMENT_OWNERSHIP_LEVELS
    ?? CONST.ENTITY_PERMISSIONS
    ?? { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
}

async function setOwnershipLevel(actor, userId, level) {
  if (!actor || !userId) return false;
  try {
    const current = actor.ownership ?? {};
    await actor.update({ ownership: { ...current, [userId]: level } });
    log("setOwnershipLevel", actor.id, "user", userId, "->", level);
    return true;
  } catch (err) {
    console.error(`[${MODULE_ID}] не удалось обновить права`, err);
    return false;
  }
}

// Счётчик: +1 при открытии окна. Если было ниже Limited — поднимаем до Limited.
async function grantTempLimited(actor, userId) {
  if (!actor || !userId) return false;
  const key = `${actor.id}:${userId}`;
  const L = ownershipLevels();
  const record = tempLootPerms.get(key);

  if (record) {
    record.count++;
    log("grant: окно уже учтено, count ->", record.count);
    return true;
  }

  const current = actor.ownership?.[userId] ?? L.NONE;
  tempLootPerms.set(key, { prev: current, count: 1 });

  if (current < L.LIMITED) {
    const ok = await setOwnershipLevel(actor, userId, L.LIMITED);
    log("grant: выдали Limited (было", current, ") результат", ok);
    return ok;
  }
  log("grant: уже >= Limited (", current, "), не трогаем");
  return true;
}

// Счётчик: -1 при закрытии окна. Возвращаем уровень ТОЛЬКО когда окон не осталось.
async function revokeTempLimited(actorOrId, userId) {
  const actorId = typeof actorOrId === "string" ? actorOrId : actorOrId?.id;
  if (!actorId || !userId) return;
  const key = `${actorId}:${userId}`;
  const record = tempLootPerms.get(key);
  if (!record) {
    log("revoke: нет записи, пропускаем");
    return;
  }
  record.count--;
  log("revoke: count ->", record.count);
  if (record.count > 0) return;

  tempLootPerms.delete(key);
  const actor = game.actors.get(actorId);
  if (!actor) return;
  const L = ownershipLevels();
  const current = actor.ownership?.[userId] ?? L.NONE;
  if (current <= L.LIMITED) {
    await setOwnershipLevel(actor, userId, record.prev);
    log("revoke: вернули уровень", record.prev);
  } else {
    log("revoke: уровень стал выше Limited, не трогаем");
  }
}

async function revokeAllTempForActor(actorId) {
  const actor = game.actors.get(actorId);
  if (!actor) return;
  const L = ownershipLevels();
  const prefix = `${actorId}:`;
  const keys = Array.from(tempLootPerms.keys()).filter(k => k.startsWith(prefix));
  for (const key of keys) {
    const record = tempLootPerms.get(key);
    tempLootPerms.delete(key);
    const userId = key.slice(prefix.length);
    const current = actor.ownership?.[userId] ?? L.NONE;
    if (current <= L.LIMITED) await setOwnershipLevel(actor, userId, record.prev);
  }
}

// ============================================================
// АДАПТЕР D&D 5e
// ============================================================
const adapter = {
  id: "dnd5e",

  // --- предметы ---
  isPhysicalItem(item) {
    return [
      "weapon", "equipment", "consumable", "tool",
      "loot", "container", "backpack"
    ].includes(item?.type);
  },

  getQuantity(item) {
    const raw = foundry.utils.getProperty(item, "system.quantity");
    if (raw !== undefined && raw !== null && typeof raw === "object") {
      const n = Number(raw.value);
      return Number.isFinite(n) ? n : 1;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : 1;
  },

  getRarity(item) {
    return foundry.utils.getProperty(item, "system.rarity") ?? null;
  },

  getLevel(item) {
    // В D&D 5e уровня у предмета нет: строка «Уровень …» в окне не нужна.
    const level = foundry.utils.getProperty(item, "system.level");
    if (level === undefined || level === null) return null;
    const n = Number(level);
    return Number.isFinite(n) ? n : null;
  },

  // --- мёртв ли актёр / какие листы обслуживаем ---
  isDead: (actor, tokenDocument = null) => isDeadOrZeroHp(actor, tokenDocument),

  shouldManageActor: actor => ["character", "npc"].includes(actor?.type),

  npcActorTypes: () => ["npc"],

  // --- монеты из мешочка ---
  currencyPath: denomination => `system.currency.${denomination}`,
  coinPouchTypes: () => ["consumable"],
  quantityPaths: () => ["system.quantity"],
  usesPath: () => "system.uses",
  deathScan: scanCurrentSceneDead,

  // --- шанс дропа в листе предмета: кнопка в шапке ---
  percentControl: () => "button",

  // --- имена хуков листов D&D 5e ---
  itemSheetHooks: () => ["renderItemSheet", "renderItemSheet5e", "renderItemSheetV2"],
  actorSheetHooks: () => ["renderActorSheet", "renderActorSheet5e", "renderActorSheetV2", "renderNPCSheet"],
  actorCloseHooks: () => ["closeActorSheet", "closeActorSheetV2", "closeActorSheet5e"],

  // ============================================================
  // СЛОЙ ПРАВ И КЭША (решает дочерний модуль, база только позволяет)
  // ============================================================

  // Данные видны, если у нас есть временный LIMITED на время лута.
  canViewActorData(actor) {
    if (!actor) return false;
    if (game.user.isGM) return true;
    const record = tempLootPerms.get(`${actor.id}:${game.user.id}`);
    return !!record;
  },

  // Карточку предмета можно открыть, пока за нами числится временный LIMITED.
  canOpenActorSheet(actor) {
    if (!actor) return false;
    return tempLootPerms.has(`${actor.id}:${game.user.id}`);
  },

  // Двойной клик по мёртвому токену забираем себе, даже если прав на актёра нет.
  moduleHandlesToken(tokenDocument, actor = null) {
    const actorId = tokenDocument?.actorId ?? actor?.id ?? null;
    if (!actorId) return false;
    if (base()?.windowFor?.(actorId)?.rendered) return true;
    // Тело без прав всё равно обыскиваем: данные придут от ГМа.
    if (!["character", "npc"].includes(actor?.type ?? tokenDocument?.actor?.type)) return false;
    return isDeadOrZeroHp(actor, tokenDocument);
  },

  // Открытие через ГМа: окно сразу показывается с «Ожидание данных…».
  requestOpenCorpse({ actorId, actorUuid = null, tokenUuid = null }) {
    const api = base();
    if (!api) return false;
    if (api.windowFor?.(actorId)) return true;

    // Страховка: окно добычи открываем только по мёртвым телам. Живое существо —
    // возвращаем false, и ядро отрабатывает двойной клик как обычно (открывает лист).
    const { doc, actor } = corpsePair(actorId, actorUuid, tokenUuid);
    if (!isDeadOrZeroHp(actor ?? null, doc)) return false;

    if (!game.users.some(user => user.isGM && user.active)) {
      ui.notifications.warn("Для открытия добычи нужен активный ГМ.");
      return true;
    }

    // Сокет не приходит самому отправителю: когда активный ГМ — это мы, запрос
    // обрабатываем на месте и окно открываем сразу со списком добычи.
    const primary = api.getPrimaryGM?.();
    if (game.user.isGM && (!primary || primary.id === game.user.id)) {
      log("requestOpenCorpse локально (активный ГМ — мы) ->", actorId);
      void handleOpenRequest({
        actorId,
        actorUuid,
        tokenUuid,
        requestingUserId: game.user.id,
        local: true
      });
      return true;
    }

    // Окно с ожиданием данных: список и права придут от ГМа по сокету.
    void api.openLootWindowFromSnapshot({
      actorId,
      actorUuid,
      tokenUuid,
      actorName: game.actors.get(actorId)?.name ?? "",
      snapshot: null
    });

    log("requestOpenCorpse ->", actorId);
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "dmlOpenRequest",
      actorId,
      actorUuid,
      tokenUuid,
      requestingUserId: game.user.id
    });
    return true;
  },

  // Окно открыто: просим ГМа выдать временный LIMITED только когда данных ещё нет.
  // Если список уже пришёл (dmlOpenGranted), запрос на права отправлял не этот вызов.
  onWindowOpened(app, info) {
    if (game.user.isGM) return false;
    if (!info?.actorId) return false;
    if (app?.snapshot !== undefined) return false;
    log("onWindowOpened:", info.actorId);
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "dmlOpenRequest",
      actorId: info.actorId,
      actorUuid: info.actorUuid ?? null,
      tokenUuid: info.tokenUuid ?? null,
      requestingUserId: game.user.id
    });
    return true;
  },

  // Окно закрыто: просим ГМа снять временный LIMITED.
  onWindowClosed(app) {
    if (app?.holdsTempAccess !== true) return false;
    const actorId = app.actorId;
    if (!actorId) return false;
    log("onWindowClosed -> release", actorId);
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "dmlRelease",
      actorId,
      userId: game.user.id
    });
    return true;
  },

  // Окно живёт на кэше: список прислал ГМ, локальных предметов может не быть.
  prepareWindowContext(context, app) {
    if (app?.actor || app?.snapshot !== undefined) return null;
    const cached = lootDataCache.get(app?.actorId);
    if (!cached) {
      context.items = [];
      context.waitingForData = true;
      return context;
    }
    context.actorName = app.displayName || cached.actorName || "";
    context.items = (cached.items ?? []).map(entry => ({
      id: entry.id,
      name: entry.name ?? "Без имени",
      img: entry.img ?? "icons/svg/item-bag.svg",
      qty: Number(entry.qty) || 1,
      showQty: (Number(entry.qty) || 1) > 1,
      levelLabel: entry.levelLabel ?? null,
      rarity: base()?.normalizeRarity?.(entry.rarity) ?? "common"
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return context;
  },

  // Есть ли у нас список добычи без локальных предметов (кэш от ГМа).
  hasCachedLoot: actorId => lootDataCache.has(actorId),

  // Где искать текст мешочка монет.
  itemDescription: item => foundry.utils.getProperty(item, "system.description.value") ?? "",

  // Перенос без локальных прав — через ГМа (свой сокет, чтобы не зависеть от базы).
  takeViaExtension(payload, app) {
    if (game.user.isGM) return false;
    const actorId = app?.actorId ?? null;
    if (!actorId) return false;
    const cached = lootDataCache.get(actorId);
    if (!cached) return false;

    // Есть локальные предметы и права — пусть перенос делает база.
    if (app?.actor && base()?.canViewActorData?.(app.actor)) return false;

    requestTakeLoot({
      sourceActorUuid: app?.actor?.uuid ?? app?.actorUuid ?? cached.actorUuid ?? null,
      itemId: payload.itemId,
      sourceTokenUuid: app?.tokenUuid ?? cached.tokenUuid ?? null
    });
    return true;
  },

  // Карточка предмета у игрока открывается у ГМа (свой сокет).
  itemSheetViaExtension(payload, app) {
    if (game.user.isGM) return false;
    const actorId = app?.actorId ?? payload.actorId;
    const cached = lootDataCache.get(actorId);
    const stillListed = Array.isArray(cached?.items) && cached.items.some(entry => entry?.id === payload.itemId);
    if (!stillListed) return false;

    if (!game.users.some(user => user.isGM && user.active)) {
      ui.notifications.info("Карточка предмета недоступна: нет активного ГМа.");
      return true;
    }

    log("itemSheetViaExtension ->", actorId, payload.itemId);
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "dmlItemSheet",
      requestingUserId: game.user.id,
      actorId,
      actorUuid: app?.actor?.uuid ?? app?.actorUuid ?? cached?.actorUuid ?? null,
      itemId: payload.itemId
    });
    return true;
  },

  // Снимок добычи расходится по игрокам в сообщениях lootUpdated.
  broadcastSnapshot(actor, items) {
    if (!game.user.isGM) return false;
    const primary = base()?.getPrimaryGM?.();
    if (primary && primary.id !== game.user.id) return false;
    log("broadcastSnapshot", actor?.id, "items:", items?.length ?? 0);
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "lootUpdated",
      actorId: actor.id,
      actorName: actor.name ?? "",
      items
    });
    return true;
  },

  // Существо ожило: просим ГМа снять временные права и чистим свой кэш.
  onActorRevived(actor) {
    lootDataCache.delete(actor?.id);
    if (game.user.isGM) return false;
    if (!tempLootPerms.has(`${actor?.id}:${game.user.id}`)) return false;
    log("onActorRevived -> release", actor.id);
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "dmlReleaseAll",
      actorId: actor.id,
      userId: game.user.id
    });
    return true;
  },

  // Сообщения собственного сокета: права, кэш, ответы ГМа.
  handleSocket(data) {
    switch (data?.type) {
      case "dmlOpenRequest": {
        if (!game.user.isGM) return true;
        const primary = base()?.getPrimaryGM?.();
        if (primary && primary.id !== game.user.id) return true;
        void handleOpenRequest(data);
        return true;
      }

      case "dmlOpenGranted": {
        if (data.forUserId && data.forUserId !== game.user.id) return true;
        applyOpenGrant(data);
        return true;
      }

      case "dmlOpenDenied": {
        if (data.requestingUserId !== game.user.id) return true;
        const api = base();
        const app = api?.windowFor?.(data.actorId);
        if (app) void app.close();
        if (data.reason) ui.notifications.warn(data.reason);
        return true;
      }

      case "dmlRelease": {
        if (!game.user.isGM) return true;
        const primary = base()?.getPrimaryGM?.();
        if (primary && primary.id !== game.user.id) return true;
        void revokeTempLimited(data.actorId, data.userId ?? data.requestingUserId);
        return true;
      }

      case "dmlReleaseAll": {
        // Существо ожило: снимаем все временные права на него разом.
        if (!game.user.isGM) return true;
        const primary = base()?.getPrimaryGM?.();
        if (primary && primary.id !== game.user.id) return true;
        void revokeAllTempForActor(data.actorId);
        return true;
      }

      case "dmlItemSheet": {
        if (!game.user.isGM) return true;
        const primary = base()?.getPrimaryGM?.();
        if (primary && primary.id !== game.user.id) return true;
        void handleItemSheetRequest(data);
        return true;
      }

      case "takeLoot": {
        // Перенос по запросу игрока: делает его тот же ГМ, что и выдаёт добычу.
        if (!game.user.isGM) return true;
        const primary = base()?.getPrimaryGM?.();
        if (primary && primary.id !== game.user.id) return true;
        void base()?.handleTakeLoot?.(data);
        return true;
      }

      case "lootUpdated": {
        if (Array.isArray(data.items)) {
          const cached = lootDataCache.get(data.actorId);
          if (cached) {
            cached.items = data.items;
            if (data.actorName) cached.actorName = data.actorName;
          }
          const app = base()?.windowFor?.(data.actorId);
          if (app && app.snapshot !== undefined) app.applySnapshot(data.items, data.actorName ?? null);
        }
        // Дальше базу не пускаем: своего актёра у нас может не быть.
        return true;
      }

      default:
        return false;
    }
  }
};

// ============================================================
// ОБРАБОТКА СООБЩЕНИЙ НА СТОРОНЕ ГМА
// ============================================================
async function handleOpenRequest({ actorId, actorUuid = null, tokenUuid = null, requestingUserId = null, local = false }) {
  const api = base();
  if (!api) return;

  // local === true значит, что ГМ и проситель — один и тот же клиент: сокет сам себе
  // не приходит, поэтому отвечаем напрямую (окно или уведомление), без рассылки.
  const refuse = reason => {
    if (local) {
      ui.notifications.warn(reason);
      return;
    }
    game.socket?.emit(`module.${MODULE_ID}`, {
      type: "dmlOpenDenied",
      actorId,
      requestingUserId,
      reason
    });
  };

  try {
    const sourceActor = await api.resolveLootActor(actorUuid ?? null, tokenUuid ?? null);
    if (!sourceActor) {
      refuse("Не удалось найти это существо.");
      return;
    }
    // Токен нужен, чтобы учесть статусы «мёртв/кровоточит», повешенные прямо на токен.
    const tokenDoc = resolveSync(tokenUuid);
    if (!api.canOpenLoot(sourceActor, tokenDoc)) {
      refuse("Это существо нельзя обыскать.");
      return;
    }

    // Бросок шансов делает ГМ: у игрока прав на предметы трупа нет.
    // Важна именно актуальность, а не наличие: шансы могли поднять уже после смерти,
    // и тогда старый бросок показывал бы пустой список даже при 100%.
    await api.ensureLootRollForOpening(sourceActor);

    const items = api.getVisibleLootItems(sourceActor).map(api.buildLootItemPayload);
    log("handleOpenRequest ->", sourceActor.id, "items:", items.length);

    const grant = {
      type: "dmlOpenGranted",
      actorId: sourceActor.id,
      actorUuid: sourceActor.uuid,
      tokenUuid: tokenUuid ?? null,
      actorName: sourceActor.name ?? "",
      items,
      forUserId: requestingUserId ?? null,
      local
    };

    if (local) applyOpenGrant(grant);
    else game.socket?.emit(`module.${MODULE_ID}`, grant);

    // Выдаём временный LIMITED ПОСЛЕ списка: окно уже показало добычу.
    // Себе (ГМу) права не нужны — они и так полные.
    if (!local && requestingUserId) await grantTempLimited(sourceActor, requestingUserId);
  } catch (err) {
    console.error(`[${MODULE_ID}] Ошибка обработки запроса на открытие`, err);
    refuse("Не удалось получить список добычи. Подробности в консоли.");
  }
}

// Игрок получил список: заводим кэш и поднимаем окно.
function applyOpenGrant(data) {
  const api = base();
  if (!api || !data?.actorId) return;

  lootDataCache.set(data.actorId, {
    items: Array.isArray(data.items) ? data.items : [],
    actorUuid: data.actorUuid ?? null,
    tokenUuid: data.tokenUuid ?? null,
    actorName: data.actorName ?? ""
  });

  void api.openLootWindowFromSnapshot({
    actorId: data.actorId,
    actorUuid: data.actorUuid ?? null,
    tokenUuid: data.tokenUuid ?? null,
    actorName: data.actorName ?? "",
    snapshot: Array.isArray(data.items) ? data.items : [],
    // Локальный «ответ самому себе» прав не касался: ГМу временный LIMITED не выдавался.
    options: { holdsTempAccess: data.local !== true }
  });
}

// ГМ открыл карточку предмета игроку.
async function handleItemSheetRequest({ actorUuid, itemId, requestingUserId = null }) {
  const api = base();
  if (!api) return;
  await api.handleItemSheetRequest({ actorUuid, itemId, requestingUserId });
}

// Перенос предмета по запросу игрока.
function requestTakeLoot({ sourceActorUuid, itemId, sourceTokenUuid = null }) {
  const api = base();
  if (!api) return false;

  const targetActor = game.user.character;
  if (!targetActor) {
    ui.notifications.warn("Не указан получатель: назначь персонажа игроку.");
    return false;
  }
  if (!sourceActorUuid && !sourceTokenUuid) {
    ui.notifications.error("Не удалось определить источник добычи.");
    return false;
  }
  if (!game.users.some(user => user.isGM && user.active)) {
    ui.notifications.error("Нет активного ГМа, который может перенести предмет.");
    return false;
  }

  log("requestTakeLoot ->", { sourceActorUuid, sourceTokenUuid, itemId, target: targetActor.uuid });
  game.socket?.emit(`module.${MODULE_ID}`, {
    type: "takeLoot",
    sourceActorUuid: sourceActorUuid ?? null,
    sourceTokenUuid: sourceTokenUuid ?? null,
    itemId,
    targetActorUuid: targetActor.uuid,
    requestingUserId: game.user.id
  });
  return true;
}

// ============================================================
// ПЕРЕСЧЁТ СМЕРТЕЙ НА СЦЕНЕ (ГМ считает трупы сам)
// ============================================================
function scanCurrentSceneDead() {
  const api = base();
  if (!api || !game.user.isGM) return;
  const primary = api.getPrimaryGM?.();
  if (primary && primary.id !== game.user.id) return;

  for (const token of canvas?.tokens?.placeables ?? []) {
    try {
      const doc = token?.document;
      const actor = token?.actor ?? doc?.actor ?? null;
      // Мёртвый токен без прав на актёра: у игрока данные скрыты, но сам факт смерти виден.
      if (!actor && doc?.actorId) {
        const app = api.windowFor?.(doc.actorId);
        if (tokenShowsCorpseStatus(doc) && !app) {
          void api.openLootWindowFromSnapshot({
            actorId: doc.actorId,
            actorUuid: null,
            tokenUuid: doc.uuid ?? null,
            snapshot: null
          });
        }
      }
    } catch (err) { /* токен мог быть без актёра */ }
  }
}

// ============================================================
// ПОДКЛЮЧЕНИЕ К БАЗЕ
// ============================================================
function attachToBase() {
  const api = base();
  if (api?.register) {
    const ok = api.register(adapter);
    if (ok) log("Адаптер D&D 5e подключён к базе");
    return ok;
  }
  Hooks.call(`${BASE_ID}Register`, adapter);
  const attached = globalThis.deadsManLoot?.providers?.some?.(a => a?.id === "dnd5e");
  if (attached) log("Адаптер D&D 5e подключён к базе");
  return !!attached;
}

// Свой сокет нужен даже ГМу: через него идут ответы игрокам.
function registerSocket() {
  if (!game.socket) return;
  globalThis.deadsManLootDnd5e ??= {};
  if (globalThis.deadsManLootDnd5e.socketRegistered) return;
  globalThis.deadsManLootDnd5e.socketRegistered = true;

  game.socket.on(`module.${MODULE_ID}`, data => {
    try {
      const handled = adapter.handleSocket(data);
      // Необработанное сообщение на этом сокете молча теряется: пусть это будет видно.
      if (handled === false && data?.type) {
        console.warn(`[${MODULE_ID}] Сообщение «${data.type}» никто не обработал.`);
      }
    } catch (err) {
      console.error(`[${MODULE_ID}] Ошибка обработки сокета`, err);
    }
  });
}

Hooks.once("ready", () => {
  if (game.system?.id !== "dnd5e") return;

  const baseActive = game.modules?.get(BASE_ID)?.active === true;
  if (!baseActive) {
    warn("Базовый модуль Dead's Man Loot выключен — адаптеру не к чему подключаться.");
    return;
  }

  if (!attachToBase()) {
    warn("Не удалось подключиться к базовому модулю: проверь, что deads-man-loot включён и загружен раньше этого модуля.");
    return;
  }

  registerSocket();
});

// Диагностика в консоли браузера.
globalThis.deadsManLootDnd5e = {
  adapter,
  lootDataCache,
  tempLootPerms,
  grantTempLimited,
  revokeTempLimited,
  revokeAllTempForActor
};
