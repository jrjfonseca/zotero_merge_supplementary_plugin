# Zotero Merge Supplementary PDF

A Zotero 8 plugin that merges a supplementary/supporting information PDF into the main PDF attachment of a library item.

## What it does

Right-click any item in your Zotero library that has exactly two PDF attachments (a main paper and a supplementary file), and select **Merge Supplementary PDF**. The plugin appends the supplementary PDF pages to the end of the main PDF.

- Preserves annotations (highlights, sticky notes, ink, markup) on both PDFs
- Creates a `.backup.pdf` of the original main PDF before overwriting
- Keeps the supplementary PDF attachment untouched

## How it identifies which PDF is supplementary

The plugin checks attachment titles and filenames for keywords like:
`supplementary`, `supporting info`, `supp`, `SI`, `appendix`, `supplement`

If neither PDF matches, the plugin will tell you to rename the supplementary attachment to include one of those keywords.

## Installation

1. Download the latest `.xpi` file from the [Releases](https://github.com/jrjfonseca/zotero_merge_supplementary_plugin/releases) page
2. In Zotero, go to **Tools > Add-ons**
3. Click the gear icon and select **Install Add-on From File...**
4. Select the downloaded `.xpi` file
5. Restart Zotero

## Usage

1. Select an item in your Zotero library that has two PDF attachments
2. Right-click the item
3. Click **>> Merge Supplementary PDF <<**
4. The supplementary pages are appended to the main PDF

If the menu item is greyed out, hover over it to see why (e.g. "need 2 PDFs, found 1").

## Building from source

Requires Node.js 18+.

```bash
git clone https://github.com/jrjfonseca/zotero_merge_supplementary_plugin.git
cd zotero_merge_supplementary_plugin
npm install
npm run build
```

The built `.xpi` will be at `.scaffold/build/merge-supplementary-pdf.xpi`.

## License

AGPL-3.0-or-later
