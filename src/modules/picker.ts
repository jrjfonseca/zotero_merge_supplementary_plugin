import { getString } from "../utils/locale";
import type { TagElementProps as TagProps } from "zotero-plugin-toolkit";
import type { ScoredCandidate } from "./detect";

export interface PickResult<C> {
  main: C;
  supplementary: C[];
}

/**
 * Ask the user which PDF is the main article and which ones to append,
 * pre-filled with the automatic best guess.
 */
export async function pickManually<C extends ScoredCandidate<Zotero.Item>>(
  parent: Zotero.Item,
  candidates: C[],
  guess: {
    reason?: string;
    main?: ScoredCandidate<Zotero.Item>;
    supplementary: ScoredCandidate<Zotero.Item>[];
  },
): Promise<PickResult<C> | null> {
  // Show the guessed main first, then the guessed supplements in merge order.
  const ordered = [
    ...candidates.filter((c) => c === guess.main),
    ...guess.supplementary.filter((s) => candidates.includes(s as C)),
    ...candidates.filter(
      (c) => c !== guess.main && !guess.supplementary.includes(c),
    ),
  ] as C[];

  const data: Record<string, any> = {};
  ordered.forEach((c, i) => {
    data[`main_${i}`] = c === guess.main;
    data[`supp_${i}`] = c !== guess.main && guess.supplementary.includes(c);
  });

  const dialog = new ztoolkit.Dialog(ordered.length + 2, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      styles: { maxWidth: "640px", marginBottom: "8px" },
      children: [
        {
          tag: "p",
          namespace: "html",
          properties: {
            textContent: getString("picker-intro", {
              args: { title: parent.getDisplayTitle() },
            }),
          },
        },
        {
          tag: "p",
          namespace: "html",
          styles: { opacity: "0.7" },
          properties: {
            textContent: guess.reason
              ? getString("picker-why", { args: { reason: guess.reason } })
              : "",
          },
        },
      ],
    })
    .addCell(
      1,
      0,
      row(
        header(getString("picker-col-main")),
        header(getString("picker-col-append")),
        header(getString("picker-col-file")),
      ),
    );

  ordered.forEach((c, i) => {
    const att = c.ref;
    dialog.addCell(
      i + 2,
      0,
      row(
        {
          tag: "input",
          namespace: "html",
          id: `mergesupp-main-${i}`,
          attributes: {
            type: "radio",
            name: "mergesupp-main",
            "data-bind": `main_${i}`,
            "data-prop": "checked",
          },
        },
        {
          tag: "input",
          namespace: "html",
          id: `mergesupp-supp-${i}`,
          attributes: {
            type: "checkbox",
            "data-bind": `supp_${i}`,
            "data-prop": "checked",
          },
        },
        {
          tag: "label",
          namespace: "html",
          attributes: { for: `mergesupp-supp-${i}` },
          children: [
            {
              tag: "div",
              namespace: "html",
              properties: { textContent: att.getDisplayTitle() },
            },
            {
              tag: "div",
              namespace: "html",
              styles: { opacity: "0.7", fontSize: "0.9em" },
              properties: {
                textContent: [att.attachmentFilename, ...c.reasons]
                  .filter(Boolean)
                  .join(" · "),
              },
            },
          ],
        },
      ),
    );
  });

  dialog
    .addButton(getString("picker-confirm"), "confirm")
    .addButton(getString("picker-cancel"), "cancel")
    .setDialogData(data)
    .open(getString("picker-title"), { centerscreen: true, fitContent: true });

  await data.unloadLock?.promise;
  if (data._lastButtonId !== "confirm") return null;

  const mainIdx = ordered.findIndex((_, i) => data[`main_${i}`]);
  if (mainIdx < 0) return null;
  const supplementary = ordered.filter(
    (_, i) => i !== mainIdx && data[`supp_${i}`],
  );
  if (supplementary.length === 0) return null;
  return { main: ordered[mainIdx], supplementary };
}

// One table-like row: two fixed-width control columns and a flexible one.
function row(main: TagProps, append: TagProps, file: TagProps): TagProps {
  const fixed = (child: TagProps): TagProps => ({
    tag: "div",
    namespace: "html",
    styles: { flex: "0 0 64px", textAlign: "center" },
    children: [child],
  });
  return {
    tag: "div",
    namespace: "html",
    styles: {
      display: "flex",
      alignItems: "flex-start",
      gap: "4px",
      paddingBottom: "6px",
      maxWidth: "640px",
    },
    children: [
      fixed(main),
      fixed(append),
      {
        tag: "div",
        namespace: "html",
        styles: { flex: "1 1 auto" },
        children: [file],
      },
    ],
  };
}

function header(text: string): TagProps {
  return {
    tag: "div",
    namespace: "html",
    styles: { fontWeight: "bold" },
    properties: { textContent: text },
  };
}
