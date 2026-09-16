import { createRoot } from "react-dom/client"
import Home from "../app/page"
import "../app/globals.css"
import onycSummary from "../public/data/onyc-summary.json"
import onycProducts from "../public/data/onyc-products.json"
import starkidzSummary from "../public/data/starkidz-summary.json"
import starkidzProducts from "../public/data/starkidz-products.json"
import katsSummary from "../public/data/kats-summary.json"
import katsProducts from "../public/data/kats-products.json"
import arettoSummary from "../public/data/aretto-summary.json"
import arettoProducts from "../public/data/aretto-products.json"

Object.assign(window, {
  __MARKET_PULSE_OFFLINE_DATA__: {
    summaries: { onyc: onycSummary, starkidz: starkidzSummary, kats: katsSummary, aretto: arettoSummary },
    products: { onyc: onycProducts.products, starkidz: starkidzProducts.products, kats: katsProducts.products, aretto: arettoProducts.products },
  },
})

createRoot(document.getElementById("root")!).render(<Home />)
