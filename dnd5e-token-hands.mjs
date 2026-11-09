/**
 * D&D 5e: Руки на токене (dnd5e-token-hands) — предметный модуль.
 * Foundry VTT v13–v14, система dnd5e.
 *
 * v1.3.0: вся механика отрисовки переехала в базовый модуль «Руки на токене»
 *         (token-hands). Здесь остался только разбор того, что актёр держит
 *         в руках, и подключение к базе через Hooks.call("tokenHandsRegister").
 *
 * v1.3.1: подпись автора и ссылка на Telegram в настройках модуля.
 *
 * «В руке» = system.equipped === true у оружия / щита / расходника.
 * Надетая броня и прочий equipment — игнорируются.
 * Двуручное оружие (свойство "two") → иконка справа + затемнённая копия слева.
 * Руки пусты (ничего не equipped) → hands = null, база не рисует ничего.
 */

const MOD_ID = "dnd5e-token-hands";
const BASE_ID = "token-hands";

const AUTHOR_NAME = "Чешир Шредингера";
const AUTHOR_TELEGRAM = "https://t.me/+BKPrpQRMP7cxMWFi";

/* -------------------------------------------------------------------------- */
/*  Подключение к базе                                                        */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  if (game.system.id !== "dnd5e") {
    console.warn(`[${MOD_ID}] Нужна система dnd5e — модуль отключается.`);
    return;
  }
  const base = game.modules.get(BASE_ID);
  if (!base?.active) {
    console.warn(`[${MOD_ID}] Не включён базовый модуль «Руки на токене» (${BASE_ID}) — слотов не будет.`);
    if (game.user.isGM) ui.notifications.warn(`${game.i18n.localize("DND5E-TOKEN-HANDS.NeedsBase")} (${BASE_ID})`);
    return;
  }
  registerSettings();

  Hooks.on("renderSettingsConfig", (app, element) => injectSettingsCredits(app, element));

  const provider = {
    id: "dnd5e",
    resolveHands,
    // Порядок фолбэков: иконка из настройки → файлы модуля → иконки системы
    // (кор-иконку база добавляет сама последней).
    iconFallbacks: [unarmedIcon(), ...moduleFistCandidates(), "systems/dnd5e/icons/svg/unarmed-strike.svg", "icons/svg/combat.svg"],
  };

  // База грузится раньше (её esmodule инициализируется до нашей попытки), но на
  // случай поздней загрузки пробуем оба канала: хук и прямой вызов API.
  Hooks.call(`${BASE_ID}Register`, provider);
  if (globalThis.tokenHands?.register?.(provider)) {
    console.info(`[${MOD_ID}] подключён к базе «${BASE_ID}»`);
  } else {
    console.warn(`[${MOD_ID}] база не приняла провайдера — проверь, что ${BASE_ID} включён и обновлён.`);
  }
});

Hooks.once("ready", () => {
  window.dnd5eHands = { resolveHands, heldItems };
  console.log(`[${MOD_ID}] готов, версия ${game.modules.get(MOD_ID)?.version}`);
});

function registerSettings() {
  game.settings.register(MOD_ID, "showUnarmed", {
    name: "DND5E-TOKEN-HANDS.Settings.ShowUnarmed",
    hint: "DND5E-TOKEN-HANDS.Settings.ShowUnarmedHint",
    scope: "world", config: true, type: Boolean, default: true,
    // Перерисовку делает база: только ей известен список токенов сцены.
    onChange: () => globalThis.tokenHands?.refreshAllTokens?.(),
  });
  game.settings.register(MOD_ID, "unarmedIcon", {
    name: "DND5E-TOKEN-HANDS.Settings.UnarmedIcon",
    hint: "DND5E-TOKEN-HANDS.Settings.UnarmedIconHint",
    scope: "world", config: true, type: String, default: "",
    onChange: () => globalThis.tokenHands?.refreshAllTokens?.(),
  });
}

/* -------------------------------------------------------------------------- */
/*  Подпись автора в настройках модуля                                        */
/* -------------------------------------------------------------------------- */

/** Строка «Автор: …» и ссылка на Telegram внизу вкладки модуля в настройках. */
function injectSettingsCredits(app, element) {
  if (!(element instanceof HTMLElement)) return;
  const section = element.querySelector(`section[data-group="categories"][data-tab="${MOD_ID}"]`);
  if (!section || section.querySelector(".token-hands-credits")) return;

  const box = document.createElement("div");
  box.className = "token-hands-credits";
  box.style.cssText = [
    "margin-top:1.5rem",
    "padding-top:.75rem",
    "border-top:1px solid var(--color-border-light-tertiary, rgba(255,255,255,.15))",
    "font-size:var(--font-size-12, 12px)",
    "line-height:1.6",
    "text-align:center",
    "color:var(--color-text-secondary, inherit)",
    "opacity:.85",
  ].join(";");

  const author = document.createElement("div");
  author.textContent = `${game.i18n.localize("DND5E-TOKEN-HANDS.Settings.Credits.Author")}: ${AUTHOR_NAME}`;

  const link = document.createElement("a");
  link.href = AUTHOR_TELEGRAM;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.style.color = "inherit";
  link.style.textDecoration = "underline";
  const icon = document.createElement("i");
  icon.className = "fa-brands fa-telegram";
  icon.setAttribute("aria-hidden", "true");
  link.append(icon, document.createTextNode(` ${game.i18n.localize("DND5E-TOKEN-HANDS.Settings.Credits.Telegram")}`));

  box.append(author, link);
  section.append(box);
}

/* -------------------------------------------------------------------------- */
/*  Разбор рук актёра (dnd5e)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Руки актёра для базы. null — актёр не наш или руки пусты: база попробует
 * другой предметный модуль и в итоге ничего не нарисует.
 */
function resolveHands(actor) {
  if (!actor || (actor.type !== "character" && actor.type !== "npc")) return null;

  const showUnarmed = game.settings.get(MOD_ID, "showUnarmed");

  const held = [];
  for (const item of actor.items ?? []) {
    if (item.system?.equipped !== true) continue; // в 5e «в руке» = equipped
    const info = heldInfo(item);
    if (!info) continue;
    held.push({ item, hands: info.hands, rank: info.rank });
  }

  // Оружие → щиты → расходники; внутри группы — по порядку в листе
  held.sort((a, b) => (a.rank - b.rank) || ((a.item.sort ?? 0) - (b.item.sort ?? 0)));

  // Двуручное занимает обе руки: справа — как есть, слева — затемнённое
  const twoHanded = held.find((h) => h.hands >= 2);
  if (twoHanded) {
    return {
      right: handData(twoHanded.item),
      left: { ...handData(twoHanded.item), dim: true },
    };
  }

  if (held.length === 0) return null;

  // Один предмет → справа, слева иконка безоружной атаки (кулак из папки модуля)
  if (held.length === 1) {
    const right = handData(held[0].item);
    if (!showUnarmed) return { right, left: null };
    return {
      right,
      left: { img: unarmedIcon(), name: unarmedLabel(), item: null, dim: false },
    };
  }

  return { right: handData(held[0].item), left: handData(held[1].item) };
}

/** Что это за предмет и сколько рук занимает. null — не «в руке». */
function heldInfo(item) {
  switch (item.type) {
    case "weapon":
      return { hands: hasWeaponProperty(item, "two") ? 2 : 1, rank: 0 };
    case "shield": // на случай будущих версий системы
      return { hands: 1, rank: 1 };
    case "equipment":
      if (item.system?.type?.value === "shield") return { hands: 1, rank: 1 };
      return null; // надетая броня/одежда — не в руке
    case "consumable":
      return { hands: 1, rank: 2 }; // зелье/свиток/палочка «наготове»
    default:
      return null; // tools, loot, container и т.д.
  }
}

/** Свойство оружия с учётом разных версий dnd5e (Set / объект / массив). */
function hasWeaponProperty(item, key) {
  const props = item.system?.properties;
  if (!props) return false;
  if (typeof props.has === "function") return props.has(key);
  if (Array.isArray(props)) return props.includes(key);
  return !!props[key];
}

function handData(item) {
  return { img: item.img, name: item.name, item, dim: false };
}

/** Путь к папке модуля. */
function modulePath() {
  return game.modules.get(MOD_ID)?.path ?? `modules/${MOD_ID}`;
}

/** Кандидаты иконки кулака в корне папки модуля (автопроба расширений). */
function moduleFistCandidates() {
  const base = modulePath();
  return ["fist.webp", "fist.png", "fist.svg", "unarmed.webp", "unarmed.png"]
    .map((f) => `${base}/${f}`);
}

/** Иконка пустой руки: настройка → fist.webp из корня модуля. */
function unarmedIcon() {
  return game.settings.get(MOD_ID, "unarmedIcon") || `${modulePath()}/fist.webp`;
}

function unarmedLabel() {
  return game.i18n.localize("DND5E-TOKEN-HANDS.Unarmed");
}

/* -------------------------------------------------------------------------- */
/*  Диагностика                                                               */
/* -------------------------------------------------------------------------- */

/** Что система считает надетым/держащимся: window.dnd5eHands.heldItems(actor) */
function heldItems(actor) {
  return [...(actor?.items ?? [])]
    .filter((i) => i.system?.equipped === true)
    .map((i) => ({
      name: i.name,
      type: i.type,
      subtype: i.system?.type?.value ?? null,
      twoHanded: i.type === "weapon" ? hasWeaponProperty(i, "two") : null,
      countedAsHeld: !!heldInfo(i),
    }));
}
