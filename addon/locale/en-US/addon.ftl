startup-begin = Merge Supplementary PDF is loading
startup-finish = Merge Supplementary PDF is ready
# XUL <menuitem> renders its `label` ATTRIBUTE, not the message value/text
# content. A value-only message leaves the native MenuManager item blank, so
# this must be an attribute-style Fluent message.
menuitem-merge-label =
    .label = >> Merge Supplementary PDF <<{ $reason }
merge-progress = Merging PDFs...
merge-success = Successfully merged supplementary PDF into main document ({ $mainTitle })
merge-error-no-item = Please select a single library item
merge-error-not-enough-pdfs = Item must have exactly 2 PDF attachments (main + supplementary)
merge-error-no-supplementary = Could not identify supplementary PDF. Rename the supplementary attachment to include "supplementary", "supporting", "SI", or "supp"
merge-error-encrypted = One or more PDFs appear to be encrypted and cannot be merged
merge-error-file-missing = PDF file not found on disk: { $path }
merge-error-generic = Merge failed: { $message }
