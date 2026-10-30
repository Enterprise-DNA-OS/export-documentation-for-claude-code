---
description: Bring customers or products across from a TradeWindow Prodoc export (a list saved as CSV).
---

Read docs/replace-tradewindow-prodoc.md. Check the file's columns against the accepted names. Add any markets the customer file uses first. Run `npm run trade -- import prodoc-customers --file=imports/<file>.csv --dry-run` (or `prodoc-products`), show the counts, then repeat without --dry-run. A code that already exists stops the whole file. Then run /hs-codes for products that came across without a tariff code.
