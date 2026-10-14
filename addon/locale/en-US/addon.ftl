startup-begin = Merge Supplementary PDF is loading
startup-finish = Merge Supplementary PDF is ready

# XUL <menuitem> renders its `label` ATTRIBUTE, not the message value/text
# content. A value-only message leaves the native MenuManager item blank, so
# these must be attribute-style Fluent messages.
menuitem-merge-label =
    .label = Merge Supplementary PDFs{ $reason }
menuitem-restore-label =
    .label = Restore Original PDF (Undo Merge)
menuitem-merge-collection-label =
    .label = Merge Supplementary PDFs in Collection…

merge-progress = Detecting supplementary PDFs…
merge-progress-batch = Merging supplementary PDFs ({ $current }/{ $total })…
merge-success =
    { $count ->
        [one] Appended 1 supplementary PDF ({ $pages } pages) to “{ $mainTitle }”
       *[other] Appended { $count } supplementary PDFs ({ $pages } pages) to “{ $mainTitle }”
    }
merge-cancelled = Merge cancelled
merge-summary = Merged { $merged } · Skipped { $skipped } · Failed { $failed }
merge-summary-hint = Skipped items had no clear supplementary PDF. Merge them one at a time to choose manually.
merge-error-encrypted = One or more PDFs are encrypted and cannot be merged
merge-error-generic = Merge failed: { $message }

auto-merge-success =
    { $count ->
        [one] Automatically merged a supplementary PDF into “{ $title }”
       *[other] Automatically merged { $count } supplementary PDFs into “{ $title }”
    }

restore-progress = Restoring original PDF…
restore-success =
    { $count ->
        [one] Restored the original PDF
       *[other] Restored the original PDFs of { $count } items
    }

reason-busy = this item is already being merged
reason-read-only = the library is read-only
reason-not-enough-pdfs = need 2 or more PDFs, found { $count }
reason-legacy-merge = this item was already merged (a .backup.pdf exists)
reason-no-pages-added = no pages were added
reason-no-backup = no backup of the original PDF was found

outline-main = Main article
outline-supplementary = Supplementary information

collection-nothing-to-merge = No item in this collection has two or more unmerged PDFs.
collection-confirm =
    { $count ->
        [one] Merge supplementary PDFs for 1 item in “{ $name }”?
       *[other] Merge supplementary PDFs for { $count } items in “{ $name }”?
    }

    Only items whose supplementary PDFs are recognised with confidence are merged; the rest are skipped and left untouched.

picker-title = Choose Supplementary PDFs
picker-intro = Choose the main article PDF of “{ $title }” and the PDFs to append to it.
picker-why = Couldn’t decide automatically: { $reason }.
picker-col-main = Main
picker-col-append = Append
picker-col-file = PDF
picker-confirm = Merge
picker-cancel = Cancel

pref-automation-title = Automation
pref-auto-merge =
    .label = Merge automatically when a supplementary PDF is attached to an item
pref-auto-merge-help = Only merges when the main and supplementary PDFs are recognised with confidence. Otherwise use the item’s context menu to choose.
pref-content-detection =
    .label = Read the first pages of each PDF to recognise supplementary information
pref-merge-title = Merging
pref-keep-backup =
    .label = Keep a .backup.pdf copy of the original main PDF (needed for undo)
pref-add-outline =
    .label = Add bookmarks for the start of each supplementary PDF
pref-trash-supplementary =
    .label = Move merged supplementary attachments to the trash
