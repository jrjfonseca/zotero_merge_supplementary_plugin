# Zotero Merge Supplementary PDF

A Zotero plugin that finds the supplementary/supporting information PDFs of a
library item and appends them to the main article PDF — automatically when
you attach them, or on demand for one item, a selection, or a whole
collection.

## Features

- **Automatic detection** of which PDF is the article and which ones are
  supplementary, using:
  - attachment titles and file names (`Supporting Information`, `SI`, `ESI`,
    `Supplementary Material`, `Appendix`, `Extended Data`, and publisher file
    patterns such as ACS `_si_001`, Springer/Nature `MOESM1_ESM`, Elsevier
    `mmc1`, Wiley `sup-0001`, PNAS `sapp`, Science `_sm`)
  - the text of the first pages (an "Electronic Supplementary Information"
    heading, many "Figure S1 / Table S2" labels, an abstract, the item's DOI)
  - typical main-article titles such as "Full Text PDF" or "Accepted Version"
- **Several supplementary files** per item are merged in their natural order
  (SI 1, SI 2, …, SI 10).
- **Auto-merge**: when a supplementary PDF is attached to an item that already
  has its article PDF (drag-and-drop, "Add Attachment", Zotero Connector,
  "Find Available PDF"), it is merged in automatically.
- **Batch merge**: select many items, or right-click a collection and choose
  **Merge Supplementary PDFs in Collection…**.
- **Picker**: if a single item is ambiguous (e.g. two PDFs that both look like
  the article), a dialog lets you choose the main PDF and what to append,
  pre-filled with the best guess and the reasons behind it.
- **Bookmarks**: a PDF outline entry is added for the start of each
  supplementary file, so you can jump to it from the reader's outline.
- **Safe and undoable**: the original main PDF is kept as `<name>.backup.pdf`,
  and **Restore Original PDF (Undo Merge)** puts it back. Merged supplementary
  attachments are tagged `_merged-supplementary` (an automatic tag) and are
  never merged twice.

## How detection decides

Every PDF gets a score; positive means "supplementary". A merge only happens
on its own when exactly one PDF is clearly the article and every PDF to
append is clearly supplementary, with a safety margin between them. Anything
less certain — a preprint next to the published version, two PDFs with no
hints at all — is never merged automatically:

- auto-merge and batch merge skip it (the summary says how many were skipped);
- merging the item on its own opens the picker.

Detection details are written to the debug log (**Help › Debug Output
Logging**).

## Usage

- **Automatic**: just attach the supplementary PDF to the item. A notification
  confirms the merge.
- **One or more items**: select them, right-click › **Merge Supplementary
  PDFs**. If the entry is greyed out, its label says why (e.g. "need 2+ PDFs,
  found 1").
- **A collection**: right-click the collection › **Merge Supplementary PDFs in
  Collection…**.
- **Undo**: right-click the item › **Restore Original PDF (Undo Merge)**.

## Settings

**Zotero Settings › Merge Supplementary PDF**:

| Setting | Default |
| --- | --- |
| Merge automatically when a supplementary PDF is attached | on |
| Read the first pages of each PDF to recognise supplementary information | on |
| Keep a `.backup.pdf` copy of the original (needed for undo) | on |
| Add bookmarks for the start of each supplementary PDF | on |
| Move merged supplementary attachments to the trash | off |

## Notes

- Zotero annotations made on the main PDF stay where they are, because the
  article's pages are unchanged and the new pages go at the end. Zotero
  annotations made on a supplementary attachment stay on that attachment.
  Annotations embedded in the PDF files themselves are copied with the pages.
- Encrypted PDFs can't be merged.
- Auto-merge ignores items that arrive through Zotero sync, so two computers
  never merge the same item.

## Installation

1. Download the latest `.xpi` file from the [Releases](https://github.com/jrjfonseca/zotero_merge_supplementary_plugin/releases) page
2. In Zotero, go to **Tools › Plugins**
3. Click the gear icon and select **Install Plugin From File…**
4. Select the downloaded `.xpi` file

## Building from source

Requires Node.js 18+ (22.18+ to run the tests).

```bash
git clone https://github.com/jrjfonseca/zotero_merge_supplementary_plugin.git
cd zotero_merge_supplementary_plugin
npm install
npm run build
npm test
```

The built `.xpi` will be at `.scaffold/build/merge-supplementary-pdf.xpi`.

## License

AGPL-3.0-or-later
