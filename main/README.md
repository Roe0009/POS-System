# 7/11 Online Convenience Store — POS + Inventory

A complete local point-of-sale and inventory app with real customer/employee accounts. The frontend is HTML, CSS, and JavaScript. The backend is Java 17+ with the built-in HTTP server. No Maven, database server, Node, or internet connection is required to run it (product photos need internet to load, but the app works fine without them).

## Run in Visual Studio Code (Windows)

1. Install **JDK 17 or newer**. Open a new VS Code terminal and check `java -version`.
2. Open the **project** folder in VS Code (**File → Open Folder**).
3. Run `run.bat` from the terminal, or use **Terminal → Run Task → Start 7/11 Online Convenience Store**. On macOS/Linux, run `bash run.sh`.
4. Visit **http://localhost:8080**. Leave the terminal open while using the app.

The Java source launcher works even if `javac` is not on PATH; `java -version` must work. Install the VS Code **Extension Pack for Java** if you want Java editing features; it is optional for running the app.

## Logging in

7/11 Online Convenience Store has two separate sign-in experiences, chosen with the role tabs on the login page:

- **Customer** — anyone can create a free account (username, display name, password) or tap **Continue as guest** for an instant, no-password shopping session. Customers land on a **Home** page to browse and buy, plus a **My orders** page with their own receipt history.
- **Employee** — accounts are provisioned ahead of time (there is no public employee sign-up). Two demo accounts are seeded on first run:
  - `admin` / `admin123` (role: admin)
  - `cashier` / `cashier123` (role: employee)

  Employees land on a **Dashboard** with today's revenue, top sellers, and stock alerts, plus a staff **POS terminal**, **Inventory**, and **Sales history**.

Passwords are salted and hashed with PBKDF2 (never stored in plain text) and sessions are HTTP-only cookies that expire after 8 hours or on logout.

## What's new in this version

**Settings (gear icon)** — click the gear next to your name (top bar for staff, header for customers):

| Tab | What you can do |
| --- | --- |
| Overview | Live account stats (orders, total spent, items bought, favorite item… or sales handled / revenue for staff), member-since, last sign-in, active sessions |
| Profile | Upload / remove a profile picture, change display name and username |
| Email & phone | Add, change, verify or remove an email and a mobile number |
| Security | Change password (signs out your other devices) and **Log out of all devices** |
| Addresses | Save up to 5 delivery addresses (customers) |
| Appearance | Light / Dark / System theme |

**Guest shoppers** only get the *Appearance* tab plus a "Make an account to start shopping with us now!" invitation. Profile, email & phone, security and addresses are hidden in the UI **and** refused by the server (HTTP 403). Guests check out for pickup only.

**Email & phone verification is in demo mode.** There is no email/SMS provider connected, so the 6-digit code is shown in the settings page and printed in the server terminal. To make it real, send `code` from `setContact()` in `StoreFlowServer.java` through an email API or SMS gateway instead of printing it.

**Store additions** — wishlist (heart on any product), sort by price/name, pickup or delivery checkout (₱39 delivery, free from ₱500), saved delivery addresses, payment method choice (cash on delivery, plus GCash/card **demo** options that charge nothing), order notes, order status tracking (Pending → Preparing → Out for delivery / Ready for pickup → Completed), customers can cancel pending orders and reorder past ones, staff update statuses from *Sales & orders* (cancelling returns items to stock), cart saved between visits, login with username **or verified email**, and a 5-attempts-then-5-minute lockout on failed logins.

**Branding** — 7-Eleven-style logo (`public/img/logo.svg`, `logo-mark.svg`) and a store background on the login screen. Drop your own photos named `store-1.jpg`, `store-2.jpg`, … into `public/img/` and they play as a fading slideshow (see `public/img/README.txt`). 7-Eleven is a registered trademark: fine for coursework, but get permission before using it on a real public site.

## Login screen & loading animation

- The left panel uses a light-green gradient over a store photo. It uses your own `public/img/store-1.jpg` if present, otherwise a free Wikimedia Commons photo of a 7-Eleven at night (needs internet), otherwise the bundled illustration.
- After a successful login (customer, guest, employee or admin) a loading animation plays: a cart rolls in, groceries drop in, the 7-Eleven stripe bar fills, then the store's automatic doors slide open onto the app. It waits for the real data to load, and respects the *reduce motion* setting.

## Expiration dates

- **Customers** see each product's expiration date on the product card and in the product details popup, with a clear status: *Exp. Mar 3, 2027*, *Expires in 3 days*, *Expires today* or *Expired*. Products without a date show "Not specified" in the details popup.
- **Staff (employee/admin)** can set, change or remove the date three ways: the **Expiry** button on any row in *Inventory*, **Change date / Set date** inside the product details popup, or the optional *Expiration date* field in *Add / Edit product*. The **Dashboard** has an *Expiry alerts* panel listing products in stock that are expired or expire within 7 days.
- **Expired products can't be sold.** Their add-to-cart buttons are disabled, they are removed from saved carts, and the server also rejects them at checkout. Staff can still edit them and adjust stock.
- Dates are stored as `YYYY-MM-DD` (API: `POST /api/products/{id}/expiry` with `expiry=YYYY-MM-DD`; an empty value clears it; employee/admin only). Existing products keep working and simply have no date until one is set.

## Features

- Clickable product cards: tapping any item in the catalog opens a details popup (photo, price, stock status, description). Customers can pick a quantity and add to cart from it; employees also get **Edit description**, **Edit product** and **Adjust stock** right inside the popup.

- Separate, real customer and employee login systems with server-side sessions — not just a client-side toggle.
- Point of sale / shopping cart with search, category filters, quantity controls, cash received, automatic change calculation, and printable receipts.
- Inventory management with create, edit, stock adjustments, delete, and a configurable low-stock threshold (employee/admin only).
- Employee dashboard with today's revenue, transaction count, a top-sellers bar chart, and low-stock alerts.
- Full sales history for staff; customers see only their own order history under "My orders".
- Server-side price and stock validation; simultaneous checkouts cannot oversell an item.
- Data (products, sales, accounts) saved to `data/storeflow.dat` after each successful change. Stop the server before copying/backing up this file. Sessions themselves are in-memory only, so everyone is signed out when the server restarts.

The app starts with sample food & beverage products, which you can edit or delete. It binds to **localhost** for single-computer use. Payment is a record of **cash received**, not an integration with a payment processor. For a real multi-device business deployment, add a supported database, backups, HTTPS, and appropriate payment and tax handling.

## Project layout

```
7-11-online-store/
  src/StoreFlowServer.java   Java HTTP API, auth, validation and persistence
  public/index.html          App shell (landing, login, dashboard, shop, settings)
  public/img/                Logo files and store background photos
  public/styles.css          Responsive, theme-aware design
  public/app.js              UI, routing and API calls
  .vscode/tasks.json         One-click VS Code task
  run.bat / run.sh           Launch scripts
  data/                      Generated automatically at first run
```

If port 8080 is already in use, set `STOREFLOW_PORT` to another port before running the script; for example `set STOREFLOW_PORT=8081` in Windows Command Prompt or `STOREFLOW_PORT=8081 bash run.sh` on macOS/Linux.
