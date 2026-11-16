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
  const TAG_DEL = "🗑️ **Mensaje eliminado**";
  const TAG_EDIT = "✏️ **Antes:**";

  const DEFAULTS = { keepDeleted: true, showEdits: true, ignoreSelf: true };

  let MessageStore, ChannelStore, UserStore;
  let unpatch;

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

  function addLog(entry) {
    storage.log = [entry, ...(storage.log ?? [])].slice(0, MAX_ENTRIES);
  }

  function baseInfo(msg, channelId, guildId) {
    const ch = ChannelStore.getChannel(channelId);
    return {
      time: Date.now(),
      messageId: msg.id,
      channelId,
      guildId: guildId ?? ch?.guild_id ?? null,
      channel: ch?.name ?? "MD",
      author: msg.author?.globalName ?? msg.author?.username ?? "desconocido",
      authorId: msg.author?.id ?? null,
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
    const msg = MessageStore.getMessage(channelId, id);
    if (!msg) return false;

    const content = msg.content ?? "";
    if (content.includes(TAG_DEL)) return !!storage.keepDeleted; // ya estaba marcado

    if (storage.ignoreSelf && msg.author?.id === me()) return false;

    const clean = stripTags(content);
    const attachments = (msg.attachments ?? [])
      .map((a) => a.url ?? a.proxy_url)
      .filter(Boolean);
    if (!clean && !attachments.length) return false;

    addLog({
      ...baseInfo(msg, channelId, guildId),
      type: "delete",
      content: clean,
      attachments,
    });

    if (!storage.keepDeleted) return false;

    orig({
      type: "MESSAGE_UPDATE",
      guildId,
      message: {
        id,
        channel_id: channelId,
        guild_id: guildId,
        content: withTag(clean, TAG_DEL),
      },
    });
    return true;
  }

  // Devuelve un evento modificado o null si no hay que tocar nada
  function processEdit(event) {
    const m = event.message;
    if (!m || m.content === undefined || !m.channel_id || !m.id) return null;

    const old = MessageStore.getMessage(m.channel_id, m.id);
    if (!old) return null;

    const oldClean = stripTags(old.content);
    const newContent = m.content ?? "";

    if (oldClean === newContent) {
      // actualización sin cambio de texto (embeds, etc.): conservar las marcas
      if (old.content !== oldClean) {
        return { ...event, message: { ...m, content: old.content } };
      }
      return null;
    }

    if (storage.ignoreSelf && old.author?.id === me()) return null;

    addLog({
      ...baseInfo(old, m.channel_id, event.guildId ?? m.guild_id),
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
              if (event.type === "MESSAGE_DELETE") {
                if (processDelete(orig, event.channelId, event.id, event.guildId)) return;
              } else if (event.type === "MESSAGE_DELETE_BULK") {
                const ids = event.ids ?? [];
                const rest = ids.filter(
                  (id) => !processDelete(orig, event.channelId, id, event.guildId)
                );
                if (rest.length !== ids.length) {
                  if (!rest.length) return;
                  return orig({ ...event, ids: rest });
                }
              } else if (event.type === "MESSAGE_UPDATE") {
                const modified = processEdit(event);
                if (modified) return orig(modified);
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
      },
      settings: Settings,
    },
  };
})()
