(function () {
  "use strict";

  const { findByStoreName, findByProps } = vendetta.metro;
  const common = vendetta.metro.common;
  const { React, ReactNative, FluxDispatcher } = common;
  const { instead } = vendetta.patcher;
  const { useProxy } = vendetta.storage;
  const { showToast } = vendetta.ui.toasts;
  const { getAssetIDByName } = vendetta.ui.assets;
  const storage = vendetta.plugin.storage;

  const h = React.createElement;
  const { View, Text, TextInput, TouchableOpacity, ScrollView, Switch } = ReactNative;

  const MAX_ENTRIES = 1500; // los fijados no cuentan para el recorte
  const MAX_CACHE = 3000; // mensajes recordados en memoria
  const MAX_KEPT = 300; // mensajes eliminados que se vuelven a mostrar al recargar un chat
  const PAGE = 30; // entradas por página en la pantalla
  const DEL_MARK = "🗑️ Mensaje eliminado";
  const TAG_EDIT = "✏️ **Antes:**";
  const DEFAULTS = { keepDeleted: true, showEdits: true, ignoreSelf: true };
  const RANGES = [["Todo", 0], ["24 h", 864e5], ["7 días", 6048e5], ["30 días", 2592e6]];
  const TABS = [
    ["delete", "🗑️ Borrados"],
    ["edit", "✏️ Editados"],
    ["purge", "🧹 Purgados"],
    ["ghost", "👻 Ghost pings"],
    ["pinned", "📌 Fijados"],
    ["stats", "📊 Estadísticas"],
  ];

  let MessageStore, ChannelStore, UserStore, GuildStore;
  let unpatch;
  const cache = new Map();

  // ---------- estilos ----------

  const SC = vendetta.ui.semanticColors ?? {};
  const RAW = vendetta.ui.rawColors ?? {};
  const col = (k, fb) => SC[k] ?? fb;
  const SS = common.stylesheet ?? ReactNative.StyleSheet;
  const mk = (SS.createThemedStyleSheet ?? ReactNative.StyleSheet.create).bind(SS);
  const BRAND = RAW.BRAND_500 ?? "#5865f2";
  const RED = "#ed4245";
  const YELLOW = "#faa61a";
  const GREEN = "#3ba55d";

  const S = mk({
    root: { padding: 12, paddingBottom: 40 },
    card: { backgroundColor: col("BACKGROUND_SECONDARY", "#2b2d31"), borderRadius: 10, padding: 10, marginBottom: 10 },
    row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
    wrap: { flexDirection: "row", flexWrap: "wrap" },
    text: { color: col("TEXT_NORMAL", "#dbdee1"), fontSize: 14 },
    muted: { color: col("TEXT_MUTED", "#949ba4"), fontSize: 12, marginTop: 2 },
    place: { color: col("TEXT_NORMAL", "#dbdee1"), fontSize: 13, fontWeight: "600", marginTop: 3 },
    author: { color: col("TEXT_NORMAL", "#dbdee1"), fontSize: 15, fontWeight: "bold", marginRight: 6 },
    badge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginRight: 4 },
    badgeText: { color: "#ffffff", fontSize: 10, fontWeight: "bold" },
    box: { backgroundColor: col("BACKGROUND_TERTIARY", "#1e1f22"), borderRadius: 6, padding: 8, marginTop: 6, borderLeftWidth: 3 },
    boxDel: { borderLeftColor: RED },
    boxNew: { borderLeftColor: GREEN },
    boxLabel: { color: col("TEXT_MUTED", "#949ba4"), fontSize: 11, fontWeight: "bold", marginBottom: 2 },
    chip: { backgroundColor: col("BACKGROUND_TERTIARY", "#1e1f22"), borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, marginRight: 6, marginBottom: 6 },
    chipOn: { backgroundColor: BRAND },
    chipText: { color: col("TEXT_NORMAL", "#dbdee1"), fontSize: 13 },
    chipTextOn: { color: "#ffffff", fontSize: 13, fontWeight: "bold" },
    input: { color: col("TEXT_NORMAL", "#dbdee1"), backgroundColor: col("BACKGROUND_TERTIARY", "#1e1f22"), borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, marginBottom: 8 },
    actions: { flexDirection: "row", marginTop: 8 },
    action: { backgroundColor: col("BACKGROUND_TERTIARY", "#1e1f22"), borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, marginRight: 6 },
    actionText: { color: col("TEXT_NORMAL", "#dbdee1"), fontSize: 12 },
    optRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
    bigBtn: { borderRadius: 8, paddingVertical: 10, alignItems: "center", marginTop: 8 },
    bigBtnText: { color: "#ffffff", fontSize: 14, fontWeight: "bold" },
    title: { color: col("TEXT_NORMAL", "#dbdee1"), fontSize: 16, fontWeight: "bold", marginBottom: 6 },
  });

  // ---------- utilidades ----------

  // Un mensaje eliminado se muestra dentro de un bloque "diff": las líneas con "- " salen en rojo
  const wrapDeleted = (text) =>
    "```diff\n" +
    (text ? text.replace(/```/g, "'''").split("\n").map((l) => "- " + l).join("\n") + "\n" : "") +
    "- " + DEL_MARK + "\n```";

  const isDeleted = (c) => !!c && c.startsWith("```diff\n") && c.includes("- " + DEL_MARK);

  const unwrapDeleted = (c) => {
    const lines = c.split("\n");
    lines.shift();
    while (lines.length && (lines[lines.length - 1] === "```" || lines[lines.length - 1] === "- " + DEL_MARK)) lines.pop();
    return lines.map((l) => (l.startsWith("- ") ? l.slice(2) : l)).join("\n");
  };

  const stripTags = (c) => {
    if (!c) return "";
    if (isDeleted(c)) return unwrapDeleted(c);
    const i = c.indexOf(TAG_EDIT);
    return (i === -1 ? c : c.slice(0, i)).replace(/\s+$/, "");
  };

  const withTag = (content, tag) => (content ? content + "\n\n" + tag : tag);
  const quote = (text) => text.split("\n").map((l) => "> " + l).join("\n");
  const me = () => UserStore.getCurrentUser()?.id;
  const nameOf = (a) => a?.globalName ?? a?.global_name ?? a?.username ?? "desconocido";
  const urlsOf = (list) => Array.from(list ?? []).map((a) => a.url ?? a.proxy_url).filter(Boolean);
  const newUid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clone = () => JSON.parse(JSON.stringify(storage.log ?? []));

  const isGuildEntry = (e) => e.kind === "guild" || (!e.kind && !!e.guildId);

  // nombre del servidor: el guardado, o uno nuevo buscado en Discord si faltaba
  const guildNameOf = (e) => {
    if (e.guildName && e.guildName !== "Servidor") return e.guildName;
    try {
      const g = GuildStore?.getGuild(e.guildId);
      if (g?.name) return g.name;
    } catch (err) {}
    return e.guildName ?? "Servidor desconocido";
  };

  const placeOf = (e) =>
    isGuildEntry(e)
      ? `#${e.channel} · ${guildNameOf(e)}`
      : e.kind === "group"
      ? `Grupo · ${e.channel}`
      : `Mensaje Directo · ${e.channel ?? "desconocido"}`;

  // versión con emoji para mostrar en pantalla
  const placeLabel = (e) =>
    isGuildEntry(e)
      ? `🏠 ${guildNameOf(e)}  ·  #${e.channel}`
      : e.kind === "group"
      ? `👥 Grupo · ${e.channel}`
      : `💬 Mensaje directo · ${e.channel ?? "desconocido"}`;

  const scopeOf = (e) =>
    isGuildEntry(e) ? guildNameOf(e) : e.kind === "group" ? "Grupos" : "Mensajes directos";

  const labelOf = (e) => (e.purged ? "PURGADO" : e.type === "edit" ? "EDITADO" : "BORRADO");

  function describePlace(channelId, guildId) {
    const ch = ChannelStore.getChannel(channelId);
    const gid = guildId ?? ch?.guild_id ?? null;
    if (gid) {
      let g = GuildStore?.getGuild(gid);
      if (!g?.name) {
        try { g = GuildStore?.getGuilds?.()?.[gid]; } catch (err) {}
      }
      return { kind: "guild", guildId: gid, guildName: g?.name ?? "Servidor", channel: ch?.name ?? "canal" };
    }
    const names = (ch?.recipients ?? [])
      .map((id) => {
        const u = UserStore.getUser(id);
        return u ? nameOf(u) : null;
      })
      .filter(Boolean);
    if (ch?.type === 3) {
      return { kind: "group", guildId: null, guildName: null, channel: ch?.name || names.join(", ") || "Grupo" };
    }
    return { kind: "dm", guildId: null, guildName: null, channel: names[0] ?? ch?.name ?? "desconocido" };
  }

  function remember(raw, channelIdFallback) {
    try {
      if (!raw || !raw.id) return;
      const channelId = raw.channel_id ?? channelIdFallback;
      if (!channelId) return;
      const key = channelId + ":" + raw.id;
      const prev = cache.get(key);
      const hasMentions = raw.mentions !== undefined || raw.mention_everyone !== undefined;
      const entry = {
        content: raw.content !== undefined ? stripTags(raw.content) : prev?.content,
        attachments: raw.attachments ? urlsOf(raw.attachments) : prev?.attachments,
        author: raw.author ?? prev?.author,
        raw: { ...(prev?.raw ?? {}), ...raw, channel_id: channelId },
        pingsMe: hasMentions
          ? !!(raw.mention_everyone || (raw.mentions ?? []).some((u) => u.id === me()))
          : prev?.pingsMe,
      };
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    } catch (e) {}
  }

  function addLog(entry) {
    const l = [{ uid: newUid(), pinned: false, ...entry }, ...clone()];
    let extra = l.length - MAX_ENTRIES;
    const trimmed = extra > 0;
    for (let i = l.length - 1; i >= 0 && extra > 0; i--) {
      if (!l[i].pinned) {
        l.splice(i, 1);
        extra--;
      }
    }
    storage.log = l;
    if (trimmed) pruneKept(l);
  }

  const mutate = (fn) => {
    const next = fn(clone());
    storage.log = next;
    pruneKept(next);
  };

  // ids de Discord: comparar como texto numérico sin usar BigInt
  const cmpId = (a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

  const loadKept = () => JSON.parse(JSON.stringify(storage.kept ?? {}));

  // guarda una copia del mensaje eliminado para volver a mostrarlo cuando se recargue el chat
  function keepRaw(channelId, raw) {
    try {
      const kept = loadKept();
      kept[channelId] = (kept[channelId] ?? []).filter((r) => r.id !== raw.id).concat([raw]);
      const all = [];
      for (const ch in kept) for (const r of kept[ch]) all.push(r);
      if (all.length > MAX_KEPT) {
        all.sort((a, b) => (a.__keptAt ?? 0) - (b.__keptAt ?? 0));
        const drop = new Set(all.slice(0, all.length - MAX_KEPT).map((r) => r.id));
        for (const ch in kept) kept[ch] = kept[ch].filter((r) => !drop.has(r.id));
      }
      storage.kept = kept;
    } catch (e) {}
  }

  // descarta las copias cuya entrada ya no está en el registro
  function pruneKept(log) {
    try {
      const ids = new Set(log.filter((e) => e.type === "delete").map((e) => e.messageId));
      const kept = loadKept();
      for (const ch in kept) {
        kept[ch] = kept[ch].filter((r) => ids.has(r.id));
        if (!kept[ch].length) delete kept[ch];
      }
      storage.kept = kept;
    } catch (e) {}
  }

  // al cargar un chat, vuelve a meter los mensajes eliminados que el servidor ya no devuelve
  function injectKept(event) {
    if (!storage.keepDeleted) return event;
    const list = storage.kept?.[event.channelId];
    if (!list?.length || !event.messages?.length) return event;
    const msgs = Array.from(event.messages);
    const have = new Set(msgs.map((m) => m.id));
    const ids = msgs.map((m) => m.id).sort(cmpId);
    const minId = ids[0];
    const maxId = ids[ids.length - 1];
    const latest = !event.hasMoreAfter;
    const add = Array.from(list)
      .filter((r) => !have.has(r.id) && cmpId(r.id, minId) >= 0 && (latest || cmpId(r.id, maxId) <= 0))
      .map((r) => {
        const { __keptAt, ...rest } = r;
        return JSON.parse(JSON.stringify(rest));
      });
    if (!add.length) return event;
    return { ...event, messages: msgs.concat(add).sort((a, b) => cmpId(b.id, a.id)) };
  }

  function entryToText(e) {
    const cab = `[${new Date(e.time).toLocaleString()}] ${labelOf(e)}${e.ghost ? " (ghost ping)" : ""} · ${e.author} · ${placeOf(e)}`;
    if (e.type === "delete") {
      let t = cab + "\n" + (e.content || "(sin texto)");
      if (e.attachments?.length) t += "\nAdjuntos:\n" + e.attachments.join("\n");
      return t;
    }
    return `${cab}\nAntes: ${e.before || "(vacío)"}\nDespués: ${e.after || "(vacío)"}`;
  }

  function copy(text) {
    try {
      const cb = common.clipboard ?? findByProps("setString", "getString");
      cb.setString(text);
      showToast("Copiado", getAssetIDByName("check"));
    } catch (e) {
      showToast("No se pudo copiar", getAssetIDByName("small_x"));
    }
  }

  // ---------- lógica principal ----------

  function processDelete(orig, channelId, id, guildId, purged) {
    const key = channelId + ":" + id;
    const cached = cache.get(key);
    const msg = MessageStore.getMessage(channelId, id);
    if (!cached && !msg) return false;

    const storeContent = msg?.content ?? "";
    if (isDeleted(storeContent)) return !!storage.keepDeleted;

    const author = cached?.author ?? msg?.author;
    if (storage.ignoreSelf && author?.id && author.id === me()) return false;

    const clean = cached?.content || stripTags(storeContent);
    const attachments = cached?.attachments?.length ? cached.attachments : urlsOf(msg?.attachments);

    storage.lastDelete = `fuente=${cached?.content ? "caché" : msg ? "tienda" : "ninguna"}, largo=${clean.length}, adjuntos=${attachments.length}, copia=${cached?.raw ? "sí" : "no"}`;

    if (!clean && !attachments.length) return false;

    addLog({
      time: Date.now(),
      type: "delete",
      purged: !!purged,
      ghost: !!(cached?.pingsMe ?? msg?.mentioned),
      messageId: id,
      channelId,
      ...describePlace(channelId, guildId),
      author: nameOf(author),
      authorId: author?.id ?? null,
      content: clean,
      attachments,
    });

    if (!storage.keepDeleted) return false;

    const shown = clean || attachments.join("\n");
    if (cached?.raw) {
      keepRaw(channelId, { ...cached.raw, content: wrapDeleted(shown), channel_id: channelId, __keptAt: Date.now() });
    }
    orig({
      type: "MESSAGE_UPDATE",
      guildId,
      message: { id, channel_id: channelId, guild_id: guildId, content: wrapDeleted(shown) },
    });
    return true;
  }

  function processEdit(event) {
    const m = event.message;
    if (!m || m.content === undefined || !m.channel_id || !m.id) return null;

    const key = m.channel_id + ":" + m.id;
    const cached = cache.get(key);
    const old = MessageStore.getMessage(m.channel_id, m.id);
    const oldClean = cached?.content ?? stripTags(old?.content);
    const newContent = m.content ?? "";

    remember(m);

    if (!old && cached?.content === undefined) return null;

    if (oldClean === newContent) {
      if (old && old.content !== stripTags(old.content)) {
        return { ...event, message: { ...m, content: old.content } };
      }
      return null;
    }

    const author = cached?.author ?? old?.author;
    if (storage.ignoreSelf && author?.id && author.id === me()) return null;

    addLog({
      time: Date.now(),
      type: "edit",
      messageId: m.id,
      channelId: m.channel_id,
      ...describePlace(m.channel_id, event.guildId ?? m.guild_id),
      author: nameOf(author),
      authorId: author?.id ?? null,
      before: oldClean,
      after: newContent,
    });

    if (storage.showEdits && oldClean) {
      return {
        ...event,
        message: { ...m, content: withTag(newContent, TAG_EDIT + "\n" + quote(oldClean)) },
      };
    }
    return null;
  }

  // ---------- interfaz ----------

  function Btn({ label, onPress, onLongPress, on, style, textStyle }) {
    return h(
      TouchableOpacity,
      { onPress, onLongPress, style: style ?? [S.chip, on ? S.chipOn : null] },
      h(Text, { style: textStyle ?? (on ? S.chipTextOn : S.chipText) }, label)
    );
  }

  function Entry({ e }) {
    const isEdit = e.type === "edit";
    return h(
      View,
      { style: S.card },
      h(
        View,
        { style: S.row },
        h(Text, { style: S.author }, e.author),
        h(View, { style: [S.badge, { backgroundColor: isEdit ? YELLOW : RED }] }, h(Text, { style: S.badgeText }, labelOf(e))),
        e.ghost ? h(View, { style: [S.badge, { backgroundColor: BRAND }] }, h(Text, { style: S.badgeText }, "GHOST PING")) : null,
        e.pinned ? h(Text, { style: S.text }, "📌") : null
      ),
      h(Text, { style: S.place }, placeLabel(e)),
      h(Text, { style: S.muted }, new Date(e.time).toLocaleString()),
      isEdit
        ? [
            h(
              View,
              { key: "a", style: [S.box, S.boxDel] },
              h(Text, { style: S.boxLabel }, "ANTES"),
              h(Text, { style: S.text, selectable: true }, e.before || "(vacío)")
            ),
            h(
              View,
              { key: "d", style: [S.box, S.boxNew] },
              h(Text, { style: S.boxLabel }, "DESPUÉS"),
              h(Text, { style: S.text, selectable: true }, e.after || "(vacío)")
            ),
          ]
        : h(
            View,
            { style: [S.box, S.boxDel] },
            h(Text, { style: S.text, selectable: true }, e.content || (e.attachments?.length ? "[solo adjuntos]" : "(sin texto)")),
            e.attachments?.length ? h(Text, { style: S.muted, selectable: true }, e.attachments.join("\n")) : null
          ),
      h(
        View,
        { style: S.actions },
        h(Btn, { label: "📋 Copiar", style: S.action, textStyle: S.actionText, onPress: () => copy(entryToText(e)) }),
        h(Btn, {
          label: e.pinned ? "📍 Desfijar" : "📌 Fijar",
          style: S.action,
          textStyle: S.actionText,
          onPress: () => mutate((l) => l.map((x) => (x.uid === e.uid ? { ...x, pinned: !x.pinned } : x))),
        }),
        h(Btn, {
          label: "✖ Quitar",
          style: S.action,
          textStyle: S.actionText,
          onPress: () => mutate((l) => l.filter((x) => x.uid !== e.uid)),
        })
      )
    );
  }

  function Stats({ log }) {
    const now = Date.now();
    const count = (fn) => log.filter(fn).length;
    const top = (fn) => {
      const m = {};
      log.forEach((e) => {
        const k = fn(e);
        m[k] = (m[k] || 0) + 1;
      });
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5);
    };
    const line = (t, i) => h(Text, { key: t + i, style: S.text }, t);
    return h(
      View,
      null,
      h(
        View,
        { style: S.card },
        h(Text, { style: S.title }, "Resumen"),
        line(`Total de entradas: ${log.length}`, 0),
        line(`Borrados: ${count((e) => e.type === "delete" && !e.purged)}`, 1),
        line(`Editados: ${count((e) => e.type === "edit")}`, 2),
        line(`Purgados: ${count((e) => e.purged)}`, 3),
        line(`Ghost pings: ${count((e) => e.ghost)}`, 4),
        line(`Fijados: ${count((e) => e.pinned)}`, 5),
        line(`Últimas 24 h: ${count((e) => now - e.time < 864e5)}`, 6)
      ),
      h(
        View,
        { style: S.card },
        h(Text, { style: S.title }, "Autores con más entradas"),
        ...(top((e) => e.author).map(([k, v], i) => line(`${i + 1}. ${k} — ${v}`, i)) || [])
      ),
      h(
        View,
        { style: S.card },
        h(Text, { style: S.title }, "Lugares con más entradas"),
        ...(top((e) => placeOf(e)).map(([k, v], i) => line(`${i + 1}. ${k} — ${v}`, i)) || [])
      )
    );
  }

  function Settings() {
    useProxy(storage);
    const [tab, setTab] = React.useState("delete");
    const [query, setQuery] = React.useState("");
    const [scopeIdx, setScopeIdx] = React.useState(0);
    const [rangeIdx, setRangeIdx] = React.useState(0);
    const [asc, setAsc] = React.useState(false);
    const [limit, setLimit] = React.useState(PAGE);
    const [showOpts, setShowOpts] = React.useState(false);

    const log = Array.from(storage.log ?? []);

    const inTab = (e, t) =>
      t === "delete" ? e.type === "delete" && !e.purged
      : t === "edit" ? e.type === "edit"
      : t === "purge" ? !!e.purged
      : t === "ghost" ? !!e.ghost
      : t === "pinned" ? !!e.pinned
      : true;

    const scopes = ["Todos los servidores", ...Array.from(new Set(log.map(scopeOf))).sort()];
    const scope = scopes[scopeIdx % scopes.length];
    const [rangeName, rangeMs] = RANGES[rangeIdx % RANGES.length];
    const q = query.trim().toLowerCase();
    const now = Date.now();

    const rows = log
      .filter(
        (e) =>
          inTab(e, tab) &&
          (scopeIdx % scopes.length === 0 || scopeOf(e) === scope) &&
          (!rangeMs || now - e.time <= rangeMs) &&
          (!q || `${e.author} ${placeOf(e)} ${e.content ?? ""} ${e.before ?? ""} ${e.after ?? ""}`.toLowerCase().includes(q))
      )
      .sort((a, b) => (asc ? a.time - b.time : b.time - a.time));

    const reset = () => setLimit(PAGE);

    const opt = (label, key) =>
      h(
        View,
        { key, style: S.optRow },
        h(Text, { style: [S.text, { flex: 1, marginRight: 8 }] }, label),
        h(Switch, { value: !!storage[key], onValueChange: (v) => (storage[key] = v) })
      );

    return h(
      ScrollView,
      { contentContainerStyle: S.root, keyboardShouldPersistTaps: "handled" },
      h(
        View,
        { style: S.card },
        h(Text, { style: S.title }, "🗑️ Registro de mensajes"),
        h(TextInput, {
          style: S.input,
          value: query,
          placeholder: "Buscar por autor, canal o contenido...",
          placeholderTextColor: "#80848e",
          onChangeText: (t) => {
            setQuery(t);
            reset();
          },
        }),
        h(
          View,
          { style: S.wrap },
          h(Btn, { label: "🏠 " + scope, onPress: () => { setScopeIdx((scopeIdx + 1) % scopes.length); reset(); }, onLongPress: () => { setScopeIdx(0); reset(); } }),
          h(Btn, { label: "📅 " + rangeName, onPress: () => { setRangeIdx((rangeIdx + 1) % RANGES.length); reset(); } }),
          h(Btn, { label: asc ? "↕ Antiguo → nuevo" : "↕ Nuevo → antiguo", onPress: () => setAsc(!asc) })
        )
      ),
      h(
        View,
        { style: S.wrap },
        ...TABS.map(([id, name]) => {
          const n = id === "stats" ? "" : ` ${log.filter((e) => inTab(e, id)).length}`;
          return h(Btn, { key: id, label: name + n, on: tab === id, onPress: () => { setTab(id); reset(); } });
        })
      ),
      tab === "stats"
        ? h(Stats, { log })
        : [
            ...rows.slice(0, limit).map((e, i) => h(Entry, { key: e.uid ?? `${e.time}-${i}`, e })),
            rows.length === 0 ? h(Text, { key: "vacio", style: [S.muted, { textAlign: "center", marginVertical: 20 }] }, "No hay entradas para mostrar.") : null,
            rows.length > limit
              ? h(Btn, { key: "mas", label: `Mostrar más (${rows.length - limit} restantes)`, onPress: () => setLimit(limit + PAGE) })
              : null,
          ],
      h(
        TouchableOpacity,
        {
          style: [S.bigBtn, { backgroundColor: BRAND }],
          onPress: () => {
            if (!rows.length) return showToast("No hay nada para exportar");
            copy(rows.map(entryToText).join("\n\n"));
          },
        },
        h(Text, { style: S.bigBtnText }, `Exportar (${rows.length}) — copia al portapapeles`)
      ),
      h(
        TouchableOpacity,
        {
          style: [S.bigBtn, { backgroundColor: RED }],
          onPress: () =>
            vendetta.ui.alerts.showConfirmationAlert({
              title: "Limpiar registro",
              content: "Se eliminarán todas las entradas, excepto las fijadas.",
              confirmText: "Limpiar",
              cancelText: "Cancelar",
              confirmColor: "red",
              onConfirm: () => {
                mutate((l) => l.filter((e) => e.pinned));
                showToast("Registro limpio (se conservaron los fijados)", getAssetIDByName("check"));
              },
            }),
        },
        h(Text, { style: S.bigBtnText }, "Limpiar registro (conserva fijados)")
      ),
      h(
        View,
        { style: [S.card, { marginTop: 14 }] },
        h(Btn, { label: showOpts ? "⚙️ Opciones ▾" : "⚙️ Opciones ▸", style: { paddingVertical: 4 }, textStyle: S.title, onPress: () => setShowOpts(!showOpts) }),
        showOpts
          ? [
              opt("Mantener mensajes eliminados en el chat", "keepDeleted"),
              opt("Mostrar el texto anterior de los editados", "showEdits"),
              opt("Ignorar mis propios mensajes", "ignoreSelf"),
              h(Text, { key: "dbg", style: S.muted }, "Último borrado detectado: " + (storage.lastDelete || "ninguno todavía")),
            ]
          : null
      )
    );
  }

  // ---------- ciclo de vida ----------

  return {
    default: {
      onLoad() {
        MessageStore = findByStoreName("MessageStore");
        ChannelStore = findByStoreName("ChannelStore");
        UserStore = findByStoreName("UserStore");
        GuildStore = findByStoreName("GuildStore");

        for (const k in DEFAULTS) {
          if (storage[k] === undefined) storage[k] = DEFAULTS[k];
        }
        if (storage.log === undefined) storage.log = [];
        if (storage.kept === undefined) storage.kept = {};

        // migración: entradas de versiones anteriores sin id
        try {
          const old = clone();
          let changed = false;
          old.forEach((e) => {
            if (!e.uid) {
              e.uid = newUid();
              changed = true;
            }
          });
          if (changed) storage.log = old;
        } catch (e) {}

        unpatch = instead("dispatch", FluxDispatcher, (args, orig) => {
          const event = args[0];
          if (event && typeof event === "object") {
            try {
              switch (event.type) {
                case "MESSAGE_CREATE":
                  remember(event.message, event.channelId);
                  break;
                case "LOAD_MESSAGES_SUCCESS": {
                  for (const raw of event.messages ?? []) remember(raw, event.channelId);
                  const withKept = injectKept(event);
                  if (withKept !== event) return orig(withKept);
                  break;
                }
                case "MESSAGE_DELETE":
                  if (processDelete(orig, event.channelId, event.id, event.guildId, false)) return;
                  break;
                case "MESSAGE_DELETE_BULK": {
                  const ids = event.ids ?? [];
                  const rest = ids.filter((id) => !processDelete(orig, event.channelId, id, event.guildId, true));
                  if (rest.length !== ids.length) {
                    if (!rest.length) return;
                    return orig({ ...event, ids: rest });
                  }
                  break;
                }
                case "MESSAGE_UPDATE": {
                  const modified = processEdit(event);
                  if (modified) return orig(modified);
                  break;
                }
              }
            } catch (e) {
              console.error("[MessageLogger]", e);
            }
          }
          return orig(...args);
        });
      },
      onUnload() {
        unpatch?.();
        cache.clear();
      },
      settings: Settings,
    },
  };
})()
