# Zotero Merge Supplementary PDF

A Zotero plugin (tested on Zotero 10) that, in one click, **fetches an article's supplementary
information from the publisher, converts Word files to PDF, and appends it to
the main PDF** — for any journal. It also merges SI PDFs you attach yourself,
automatically.

## One click: Fetch & Merge Supplementary Info

Right-click one or more items (or a collection) › **Fetch & Merge
Supplementary Info**. For each item the plugin:

1. Gets the main article PDF first if the item has none (Zotero's "Find
   Available PDF").
2. Opens the article page from the item's URL or DOI and finds the
   supplementary files. This works on any site:
   - generic signals: links in a "Supplementary / Supporting Information"
     section, link text, file names;
   - publisher patterns, e.g. ACS `suppl_file`, Wiley `downloadSupplement`,
     Springer Nature / BMC `MOESM…_ESM`, Elsevier `mmc1` (also read from the
     page's embedded data, or from the article's PII), RSC/IOP `suppdata`,
     PLOS `type=supplementary`, PNAS `sapp`, Science `_sm`, bioRxiv `media-1`,
     Frontiers, MDPI, PMC;
   - "Supporting Information" listing pages are followed, ZIP archives are
     unpacked;
   - pages that need JavaScript or show a bot check (Cloudflare "Just a
     moment…") are loaded in Zotero's built-in browser, which also uses your
     institutional cookies;
   - if the publisher's page yields nothing (blocked, paywalled, or no
     links), other sources are tried in turn: **Figshare**, where ACS,
     Taylor & Francis, PLOS, SAGE and others mirror SI (this also covers
     paywalled ACS articles); **Europe PMC**'s SI archive for open-access
     articles; and the **PubMed Central** article page (e.g. author
     manuscripts).
3. Keeps the documents (PDF, DOCX, DOC, ODT, RTF, and PPTX/PPT/ODP slide
   decks, which some journals use for SI figures), skipping spreadsheets,
   videos, structure files, "Reporting Summary"/"Peer Review File" paperwork,
   and anything already attached.
4. **Converts Word/ODT/RTF/slides to PDF**:
   - with **LibreOffice** if it is installed (best result; found
     automatically, or set its path in the settings);
   - otherwise DOCX is converted built-in: rendered to HTML and printed to PDF
     by Zotero's own engine (tables and images included), with a plain-text
     fallback. DOC/ODT/RTF and slides need LibreOffice.
5. Attaches the files to the item and **merges them into the main PDF**, with
   a bookmark at the start of each one.

If nothing can be found (e.g. the SI is only on a page that needs a login the
plugin can't reach), download the files in your browser and drag them onto
the item — they are merged automatically.

## Merging SI you attach yourself

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
- **Fetch from the web**: right-click › **Fetch & Merge Supplementary Info**
  (items or a collection).
- **Merge what is already attached**: select items, right-click › **Merge
  Attached Supplementary PDFs**. If the entry is greyed out, its label says
  why (e.g. "need 2+ PDFs, found 1").
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
| LibreOffice program (for converting Word files) | found automatically |

## Notes

- Zotero annotations made on the main PDF stay where they are, because the
  article's pages are unchanged and the new pages go at the end. Zotero
  annotations made on a supplementary attachment stay on that attachment.
  Annotations embedded in the PDF files themselves are copied with the pages.
- Encrypted PDFs can't be merged.
- Only documents are merged into the PDF; spreadsheets, data files and videos
  stay on the publisher's site.
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

### Testing inside Zotero

`test-zotero/` holds end-to-end tests that run in a real Zotero and hit
real publisher sites: the one-click fetch on PLOS, Nature, Frontiers,
Elsevier/Lancet and MDPI articles, Find Available PDF, Word→PDF conversion with
LibreOffice and with Zotero's own print engine, the hidden browser, auto-merge
and undo.

```bash
# Linux; any Zotero build works, e.g. the tarball from zotero.org
export ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/path/to/Zotero_linux-x86_64/zotero
xvfb-run -a npm run test:zotero -- --exit-on-finish
```

Behind an HTTPS proxy, also set `ZOTERO_TEST_PROXY=host:port` and
`ZOTERO_TEST_CA=/path/to/proxy-ca.crt` (needs `certutil`).

To try the SI discovery on real articles outside Zotero (optionally with
`playwright` installed for pages that need a browser):

```bash
npm run try-fetch -- 10.1371/journal.pone.0229668 10.3389/fmicb.2020.01800
```

The built `.xpi` will be at `.scaffold/build/merge-supplementary-pdf.xpi`.

To publish a release, push a version tag (e.g. `git tag v0.4.0 && git push
origin v0.4.0`); the Release workflow builds the plugin and attaches the
`.xpi` to a GitHub release.

## License

AGPL-3.0-or-later
