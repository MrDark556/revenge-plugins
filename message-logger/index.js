(function () {
  "use strict";

  const { findByStoreName, findByProps } = vendetta.metro;
  const { React, ReactNative, FluxDispatcher } = vendetta.metro.common;
  const { instead } = vendetta.patcher;
  const { useProxy } = vendetta.storage;
  const { Forms } = vendetta.ui.components;
  const { showToast } = vendetta.ui.toasts;
  const { getAssetIDByName } = vendetta.ui.assets;
  const storage = vendetta.plugin.storage;

  const h = React.createElement;
  const { ScrollView } = ReactNative;
  const { FormSection, FormRow, FormSwitchRow, FormDivider } = Forms;

  const MAX_ENTRIES = 500; // máximo de entradas guardadas en el registro
  const MAX_SHOWN = 100; // máximo de entradas dibujadas en la pantalla de ajustes
  const MAX_CACHE = 3000; // mensajes recordados en memoria
  const TAG_DEL = "🗑️ **Mensaje eliminado**";
  const TAG_EDIT = "✏️ **Antes:**";

  const DEFAULTS = { keepDeleted: true, showEdits: true, ignoreSelf: true };

  let MessageStore, ChannelStore, UserStore;
  let unpatch;

  // caché en memoria: guarda el contenido real de cada mensaje que llega
  const cache = new Map();

  // ---------- utilidades ----------

  const stripTags = (c) => {
    if (!c) return "";
    let cut = c.length;
    for (const t of [TAG_DEL, TAG_EDIT]) {
      const i = c.indexOf(t);
      if (i !== -1 && i < cut) cut = i;
    }
    return c.slice(0, cut).replace(/\s+$/, "");
  };

  const withTag = (content, tag) => (content ? content + "\n\n" + tag : tag);

  const quote = (text) =>
    text
      .split("\n")
      .map((l) => "> " + l)
      .join("\n");

  const me = () => UserStore.getCurrentUser()?.id;

  const nameOf = (a) =>
    a?.globalName ?? a?.global_name ?? a?.username ?? "desconocido";

  const urlsOf = (list) =>
    Array.from(list ?? [])
      .map((a) => a.url ?? a.proxy_url)
      .filter(Boolean);

  function remember(raw, channelIdFallback) {
    try {
      if (!raw || !raw.id) return;
      const channelId = raw.channel_id ?? channelIdFallback;
      if (!channelId) return;
      const key = channelId + ":" + raw.id;
      const prev = cache.get(key);
      const entry = {
        content: raw.content !== undefined ? stripTags(raw.content) : prev?.content,
        attachments: raw.attachments ? urlsOf(raw.attachments) : prev?.attachments,
        author: raw.author ?? prev?.author,
      };
      cache.delete(key);
      cache.set(key, entry);
      if (cache.size > MAX_CACHE) {
        cache.delete(cache.keys().next().value);
      }
    } catch (e) {}
  }

  function addLog(entry) {
    storage.log = [entry, ...(storage.log ?? [])].slice(0, MAX_ENTRIES);
  }

  function baseInfo(author, messageId, channelId, guildId) {
    const ch = ChannelStore.getChannel(channelId);
    return {
      time: Date.now(),
      messageId,
      channelId,
      guildId: guildId ?? ch?.guild_id ?? null,
      channel: ch?.name ?? "MD",
      author: nameOf(author),
      authorId: author?.id ?? null,
    };
  }

  function entryToText(e) {
    const fecha = new Date(e.time).toLocaleString();
    const cab = `[${fecha}] ${e.type === "delete" ? "ELIMINADO" : "EDITADO"} · ${e.author} · ${e.guildId ? "#" : ""}${e.channel}`;
    if (e.type === "delete") {
      let t = cab + "\n" + (e.content || "(sin texto)");
      if (e.attachments?.length) t += "\nAdjuntos:\n" + e.attachments.join("\n");
      return t;
    }
    return `${cab}\nAntes: ${e.before || "(vacío)"}\nDespués: ${e.after || "(vacío)"}`;
  }

  function copy(text) {
    try {
      const cb =
        vendetta.metro.common.clipboard ??
        findByProps("setString", "getString");
      cb.setString(text);
      showToast("Copiado", getAssetIDByName("check"));
    } catch (e) {
      showToast("No se pudo copiar", getAssetIDByName("small_x"));
    }
  }

  // ---------- lógica principal ----------

  // Devuelve true si el evento de borrado debe tragarse (el mensaje se queda en el chat)
  function processDelete(orig, channelId, id, guildId) {
    const key = channelId + ":" + id;
    const cached = cache.get(key);
    const msg = MessageStore.getMessage(channelId, id);
    if (!cached && !msg) return false;

    const storeContent = msg?.content ?? "";
    if (storeContent.includes(TAG_DEL)) return !!storage.keepDeleted; // ya estaba marcado

    const author = cached?.author ?? msg?.author;
    if (storage.ignoreSelf && author?.id && author.id === me()) return false;

    // preferimos el texto de la caché; si no hay, el de la tienda de Discord
    const clean = cached?.content || stripTags(storeContent);
    const attachments = cached?.attachments?.length
      ? cached.attachments
      : urlsOf(msg?.attachments);

    storage.lastDelete = `fuente=${cached?.content ? "caché" : msg ? "tienda" : "ninguna"}, largo=${clean.length}, adjuntos=${attachments.length}`;

    if (!clean && !attachments.length) return false;

    addLog({
      ...baseInfo(author, id, channelId, guildId),
      type: "delete",
      content: clean,
      attachments,
    });

    if (!storage.keepDeleted) return false;

    const shown = clean || (attachments.length ? attachments.join("\n") : "");
    orig({
      type: "MESSAGE_UPDATE",
      guildId,
      message: {
        id,
        channel_id: channelId,
        guild_id: guildId,
        content: withTag(shown, TAG_DEL),
      },
    });
    return true;
  }

  // Devuelve un evento modificado o null si no hay que tocar nada
  function processEdit(event) {
    const m = event.message;
    if (!m || m.content === undefined || !m.channel_id || !m.id) return null;

    const key = m.channel_id + ":" + m.id;
    const cached = cache.get(key);
    const old = MessageStore.getMessage(m.channel_id, m.id);
    const oldClean = cached?.content ?? stripTags(old?.content);
    const newContent = m.content ?? "";

    // actualizamos la caché con el texto real que llegó del servidor
    remember(m);

    if (!old && cached?.content === undefined) return null;

    if (oldClean === newContent) {
      // actualización sin cambio de texto (embeds, etc.): conservar las marcas
      if (old && old.content !== stripTags(old.content)) {
        return { ...event, message: { ...m, content: old.content } };
      }
      return null;
    }

    const author = cached?.author ?? old?.author;
    if (storage.ignoreSelf && author?.id && author.id === me()) return null;

    addLog({
      ...baseInfo(author, m.id, m.channel_id, event.guildId ?? m.guild_id),
      type: "edit",
      before: oldClean,
      after: newContent,
    });

    if (storage.showEdits && oldClean) {
      return {
        ...event,
        message: {
          ...m,
          content: withTag(newContent, TAG_EDIT + "\n" + quote(oldClean)),
        },
      };
    }
    return null;
  }

  // ---------- pantalla de ajustes ----------

  function Settings() {
    useProxy(storage);
    const log = storage.log ?? [];

    const rows = log.slice(0, MAX_SHOWN).map((e, i) => {
      const icon = e.type === "delete" ? "🗑️" : "✏️";
      const where = (e.guildId ? "#" : "") + e.channel;
      const body =
        e.type === "delete"
          ? e.content || (e.attachments?.length ? `[${e.attachments.length} adjunto(s)]` : "")
          : `Antes: ${e.before || "(vacío)"}\nDespués: ${e.after || "(vacío)"}`;
      return h(
        React.Fragment,
        { key: `${e.time}-${i}` },
        h(FormRow, {
          label: `${icon} ${e.author} · ${where}`,
          subLabel: `${body}\n${new Date(e.time).toLocaleString()}`,
          onPress: () => copy(entryToText(e)),
        }),
        h(FormDivider)
      );
    });

    return h(
      ScrollView,
      null,
      h(
        FormSection,
        { title: "Opciones" },
        h(FormSwitchRow, {
          label: "Mantener mensajes eliminados en el chat",
          subLabel: "Los muestra con la marca 🗑️ en vez de borrarlos",
          value: !!storage.keepDeleted,
          onValueChange: (v) => (storage.keepDeleted = v),
        }),
        h(FormDivider),
        h(FormSwitchRow, {
          label: "Mostrar el texto anterior de los editados",
          subLabel: "Agrega el contenido original debajo del mensaje",
          value: !!storage.showEdits,
          onValueChange: (v) => (storage.showEdits = v),
        }),
        h(FormDivider),
        h(FormSwitchRow, {
          label: "Ignorar mis propios mensajes",
          value: !!storage.ignoreSelf,
          onValueChange: (v) => (storage.ignoreSelf = v),
        })
      ),
      h(
        FormSection,
        { title: `Registro (${log.length}/${MAX_ENTRIES})` },
        h(FormRow, {
          label: "Copiar todo el registro",
          subLabel: "Lo copia como texto al portapapeles",
          onPress: () => {
            if (!log.length) return showToast("El registro está vacío");
            copy(log.map(entryToText).join("\n\n"));
          },
        }),
        h(FormDivider),
        h(FormRow, {
          label: "Borrar registro",
          onPress: () =>
            vendetta.ui.alerts.showConfirmationAlert({
              title: "Borrar registro",
              content: "Se eliminarán todas las entradas guardadas.",
              confirmText: "Borrar",
              cancelText: "Cancelar",
              confirmColor: "red",
              onConfirm: () => {
                storage.log = [];
                showToast("Registro borrado", getAssetIDByName("check"));
              },
            }),
        })
      ),
      h(
        FormSection,
        { title: "Depuración" },
        h(FormRow, {
          label: "Último borrado detectado",
          subLabel: storage.lastDelete || "Todavía ninguno",
        })
      ),
      log.length
        ? h(FormSection, { title: `Últimas ${Math.min(log.length, MAX_SHOWN)} entradas (toca para copiar)` }, ...rows)
        : null
    );
  }

  // ---------- ciclo de vida ----------

  return {
    default: {
      onLoad() {
        MessageStore = findByStoreName("MessageStore");
        ChannelStore = findByStoreName("ChannelStore");
        UserStore = findByStoreName("UserStore");

        for (const k in DEFAULTS) {
          if (storage[k] === undefined) storage[k] = DEFAULTS[k];
        }
        if (storage.log === undefined) storage.log = [];

        unpatch = instead("dispatch", FluxDispatcher, (args, orig) => {
          const event = args[0];
          if (event && typeof event === "object") {
            try {
              switch (event.type) {
                case "MESSAGE_CREATE":
                  remember(event.message, event.channelId);
                  break;
                case "LOAD_MESSAGES_SUCCESS":
                  for (const raw of event.messages ?? []) remember(raw, event.channelId);
                  break;
                case "MESSAGE_DELETE":
                  if (processDelete(orig, event.channelId, event.id, event.guildId)) return;
                  break;
                case "MESSAGE_DELETE_BULK": {
                  const ids = event.ids ?? [];
                  const rest = ids.filter(
                    (id) => !processDelete(orig, event.channelId, id, event.guildId)
                  );
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
