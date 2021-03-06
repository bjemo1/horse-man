import transactionCollection from "./dbPool";
import puppet from "puppeteer";
import { promisify } from "util";
import { Transaction as PlaidTransaction } from "plaid";
import express from "express";
import { sendEmail } from "./mailer";
import { serializeError } from "serialize-error";

interface Transaction extends PlaidTransaction {
  complete?: boolean;
}

const timeoutAsync = promisify(setTimeout);

async function run() {
  const collection = await transactionCollection();

  const incomplete = await collection
    .find<Transaction>({ $and: [{ complete: { $ne: true } }, { account_id: { $eq: process.env.ACCOUNT_FILTER! } }] }) //TODO: test account filter
    .toArray();

  console.log(`found ${incomplete.length} incomplete transactions`);

  // incomplete.push({
  //   date: "12/27/2020",
  //   amount: 100,
  //   name: "test",
  //   transaction_id: "dunno"
  // } as any);

  if (incomplete.length === 0) return;
  try {
    const browser = await puppet.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(process.env.GOTO_PATH!);

    await timeoutAsync(5000);

    await page.type("#email", process.env.ED_EMAIL!, {
      delay: 100
    });

    await page.type("#password", process.env.ED_PASSWORD!, {
      delay: 100
    });

    await page.click("button[type='submit']");

    await timeoutAsync(5 * 1000);

    try {
      if (
        await page.waitForSelector("#Modal_close", {
          timeout: 2 * 1000
        })
      ) {
        await page.click("#Modal_close");
        await timeoutAsync(1 * 1000);
      }
    } catch (error) {
      console.log("modal didn't need to be closed");
    }

    await page.click("#IconTray_transactions .IconTray-icon");
    await timeoutAsync(1 * 1000);

    for (const transaction of incomplete) {
      await page.click("#TransactionDrawer_addNew");
      await timeoutAsync(1 * 1000);

      if (transaction.amount! < 0) {
        await page.click("#TransactionModal_typeIncome");
        await timeoutAsync(1 * 1000);
      }

      await page.type(".TransactionForm-amountInput", Math.abs(transaction.amount!).toFixed(2), {
        delay: 100
      });

      await page.focus(".dateInput input");
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(transaction.date, {
        delay: 100
      });
      await page.type(".TransactionForm-merchant input", `${transaction.name ?? transaction.merchant_name}*`, {
        delay: 100
      });
      await page.click("#TransactionModal_submit");

      await collection.updateOne({ transaction_id: { $eq: transaction.transaction_id } }, { $set: { complete: true } });

      await timeoutAsync(1 * 1000);
    }

    await page.close();
  } catch (error) {
    console.error(error);
    sendEmail("Transaction Error", JSON.stringify(serializeError(error)));
  }
}

const app = express();

app.get("/trans", async (req, res) => {
  console.log(req.path);
  try {
    await run();
    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.status(500).send(error);
  }
});

app.listen(process.env.PORT, () => {
  console.log("app started on port:", process.env.PORT);
});

(async () => await run())();
