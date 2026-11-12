# Running a shop on Omnivo: step by step

This guide is for the owner of a small shop that sells both wholesale and retail. It says where to
click, what to type and what happens next.

Two products are used as examples:

- **KitKat 2 Finger.** 1 box holds 24 pieces. You buy it at ৳17 a piece. You sell one piece for ৳20.
  When you sell a whole box, a piece costs ৳18.50, so the box is ৳444.
- **Pond's Face Wash.** It comes in 3 sizes: 50ml, 80ml and 100ml. The prices below are only examples.

The guide has two parts:

- **Part A: first-day setup.** You do this once.
- **Part B: daily work.**

---

## Part A: first-day setup

### Step 1: Shop details

1. In the menu on the left, open **Settings**.
2. Under **Company profile**, type the shop's name, address and phone number. These are printed on
   every receipt.
3. Under **Sales**, keep **Prices include VAT** turned on. The price you type is then the price the
   customer pays, like a printed MRP.
4. Under **Inventory**, keep **Allow negative stock** turned off. Omnivo then does not sell what is not
   in stock.
5. Click **Save**.

### Step 2: Add your bKash account

Omnivo already has an account for cash ("Cash in hand"). You add the bKash account yourself.

1. Go to **Accounting → Chart of accounts**.
2. Find **"1130 Mobile wallets (bKash, Nagad)"** and click **Add account** inside it.
3. Name it, for example "bKash 017XXXXXXXX", and save.
4. If you have a bank account, add it the same way inside **"1120 Bank accounts"**.

### Step 3: Add your staff

1. Go to **Team** and invite each person by email.
2. Give each person a role:
   - **Cashier:** sells and takes goods back at the counter. Nothing else.
   - **Shop manager:** buying, selling, stock and reports.

### Step 4: Add a product that is also sold by the box (KitKat)

1. Go to **Inventory → Products** and click **Add product**.
2. **Basics:**
   - Name: "KitKat 2 Finger"
   - Category: Snacks
3. **Units and packs:**
   - **Base unit:** `pcs`. Stock is always counted in pieces.
   - Click **Add a pack**. Pack: `box`. **Holds:** 24. The form then shows "1 box = 24 pcs".
   - **Pack barcode:** scan the barcode printed on the box. This matters: the counter can sell a box
     only by scanning this barcode (see Step 10).
   - **Sell in:** `pcs`. **Buy in:** `box`.
4. **Versions:** keep "One version".
   - Barcode: scan the barcode on one piece.
   - **Sale price per pcs:** 20
5. To track expiry dates, set **Stock tracking** to "Batch or lot" and tick **Batches have an expiry
   date**.
6. Click **Add product**.

### Step 5: Add a product that comes in sizes (Pond's)

1. Click **Add product**. Name: "Pond's Face Wash". Base unit: `pcs`.
2. Under **Versions**, choose **With variants**.
3. Option: **Size**. Values: **50ml, 80ml, 100ml** (separated by commas).
4. Click **Create the variants**. You get three rows. Give each row its own barcode and price:
   - 50ml: ৳120
   - 80ml: ৳170
   - 100ml: ৳210
5. Click **Add product**.

Omnivo counts the stock of each size on its own. Reports also show each size on its own.

If you have many products, you do not have to add them one by one. Use **Products → Import** to bring
them in from an Excel or CSV file in one go.

### Step 6: The wholesale price (a cheaper price for a box)

Omnivo works out the price of a box by itself: the piece price times 24, so **৳20 × 24 = ৳480**. To
sell a box for ৳444, you need this step.

1. Go to **Sales → Price lists** and click **Add price list**. Name: "Wholesale". Save.
2. Open the list and click **Add items**. Find KitKat and click **Add**. You get two rows: `pcs` and
   `box`.
3. In the `box` row, type **444**. If you leave the `pcs` row empty, a piece stays ৳20.
4. Click **Save prices**.

### Step 7: Customers and suppliers

1. **Sales → Customers → Add customer:** add the shops that buy wholesale from you.
   - Type the name and phone number.
   - **Price list:** Wholesale.
   - If you give them credit, set a **Credit limit**, for example ৳20,000. Omnivo stops a sale that
     would take them over it.
2. Also add one customer called **"Wholesale counter"** with the price list **Wholesale**. You pick it
   at the counter when someone you do not know buys a full box.
3. **Purchase → Suppliers → Add supplier:** add your suppliers, such as the Nestlé dealer and the
   Unilever dealer.
4. You do not add retail customers. At the counter, every sale starts as a "Walk-in customer".

### Step 8: Enter what the shop has today

**A. Money and dues.** Go to **Accounting → Opening balances**.

1. **First day on Omnivo:** the first day you use Omnivo.
2. **Cash in hand:** the cash in the drawer and the safe.
3. **bKash:** the money in your bKash account.
4. **Accounts receivable:** use **Add a customer** to enter what each shop owes you.
5. **Accounts payable:** use **Add a supplier** to enter what you owe each supplier.
6. Click **Post opening balances**.

**B. The goods in the shop.** Go to **Inventory → Stock → Adjustments** and click **New adjustment**.

1. Direction: **Stock in**. Reason: **Opening stock**.
2. Click **Add items**. Add every product with how many you have and what you paid for it. For
   example: KitKat, 10 box, ৳408 per box.
3. Click **Post adjustment**.

The profit reports are right only if these buying prices are right.

### Step 9: Set up the counter (POS)

1. **POS cash reasons → Add reason.** These are the reasons cash comes into or goes out of the drawer.
   - For cash coming in: Name "Cash from the owner", Kind **in**, Account **3100 Capital**.
   - For cash going out: Name "Shop expenses", Kind **out**, and an expense account.
2. **POS registers → Add register.**
   - Code: `POS1`. Name: "Front counter". Warehouse: the shop's warehouse.
   - **Where the money goes:** Cash → Cash in hand. bKash → the bKash account from Step 2.
   - **Most discount a cashier may give (%):** for example 5.
   - **Receipt paper:** 58 mm or 80 mm, the width of your printer's paper roll.
   - **Cash over and short account:** **5350 Cash over and short**.
   - **Returns allowed for (days):** 7.
   - **Exchange account:** **2190 POS exchange clearing**.
   - Save.
3. On the counter's computer, sign in and open **POS** from the menu. Click **Use this register**. If
   it asks for a PIN, set a 6-digit PIN for this computer.

Setup is done.

---

## Part B: daily work

### Step 10: Open the counter in the morning and sell

1. Open **POS**. Count the cash in the drawer by notes (how many ৳500, how many ৳100, and so on), then
   click **Open shift**. On the first day it asks where this cash came from: pick "Cash from the
   owner".
2. Sell:
   - **One piece:** scan the KitKat piece. It adds ৳20.
   - **A box:** scan the box's barcode. It adds 1 box.
   - **A box at the wholesale price:** first press **F4** and pick "Wholesale counter", then scan the
     box. It adds ৳444.
   - **Pond's:** scan the barcode of the size the customer wants.
3. Press **F12** (Pay).
   - Cash: type what the customer gave. Omnivo shows the change to give back.
   - bKash: type the TrxID.
   - One sale can be paid partly in cash and partly by bKash.
4. Click **Complete sale**. The receipt prints by itself. Then click **New sale**.
5. **Goods coming back:** press **F6**, type the receipt number, tick what came back, then pay the
   money back or give other goods in exchange.
6. If the internet goes down, keep selling. Omnivo sends everything when the connection is back.

### Step 11: Buy goods from a supplier

1. Go to **Purchase → Supplier bills** and click **New bill**.
2. Pick the supplier. In **Supplier's bill number**, type the number on the supplier's memo.
3. **Receive at:** the shop's warehouse.
4. Click **Add items**, pick KitKat, type 10 box and **Cost per box:** 408.
5. Click **Post bill**. The goods go into stock, and Omnivo records that you owe the supplier ৳4,080.
6. Enter rent and electricity bills the same way. Use **Add expense** for them instead of an item.

### Step 12: Pay a supplier

1. Go to **Purchase → Supplier payments** and click **New payment**.
2. Pick the supplier, type the amount and choose cash or bKash.
3. Choose which bills this money pays. **Apply oldest first** pays the oldest bills first.
4. Post it.

### Step 13: Sell wholesale on credit to a shop

1. Go to **Sales → Invoices** and click **New invoice**.
2. Pick the customer. Their wholesale prices come in by themselves.
3. Click **Add items**, pick KitKat, set Unit to **box** and quantity to 5. The price shows ৳444.
4. Post it. The stock goes down, and the shop now owes you ৳2,220 more.
5. When the shop pays: go to **Sales → Money receipts → Record payment**, pick the customer, type the
   amount, click **Apply oldest first** and post.

### Step 14: Close the counter at night

1. At the top of the POS, click the shift button, then **Close shift**.
2. Count the cash in the drawer again and click **Close the shift**.
3. Omnivo shows whether the cash is right, short or over. Click **Print Z report** to print the day's
   summary.

### Step 15: What the owner can check

| To know | Where to look |
|---|---|
| Today's sales, the cash on hand, what is running low | **Overview** (the first page) |
| The profit on each product | **Reports → Sales report** |
| Which shops owe you, and for how long | **Reports → Receivables aging** |
| What you owe each supplier | **Reports → Payables aging** |
| Profit or loss for the month | **Reports → Profit and loss** |
| How much of each product you have | **Inventory → Stock on hand** |
| Removing broken or expired goods | **Adjustments → Stock out**, Reason: Damaged or Expired |

---

## Three limits to know about

1. **When a walk-in customer buys a box**, the price is ৳480. To charge ৳444, press F4 and pick
   "Wholesale counter" first.
2. **The counter sells a box only by scanning the box's barcode.** If the box has no barcode, sell it
   as 24 pcs.
3. **A product with sizes (like Pond's) cannot have a carton barcode**, so the counter sells it by the
   piece only. To sell a full carton, use an invoice (Step 13).
