// vim:ts=2:sts=2:sw=2:et
// This script uses GitHub's Octokit SDK to make API requests. For more information, see "[AUTOTITLE](/rest/guides/scripting-with-the-rest-api-and-javascript)."
import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { readFile, writeFile } from "node:fs/promises";

//
async function checkAndRedeliverWebhooks() {
  // Get the values of environment variables that were set by the GitHub Actions workflow.
  const TOKEN = process.env.TOKEN;
  const LAST_REDELIVERY_FILE = process.env.LAST_REDELIVERY_FILE;
  // Trac gets overwhelmed when re-delivering too quickly, and we don't care if
  // it takes a little longer to run this script, so slow down a bit.
  const SLEEP_BETWEEN_REDELIVERIES = 3000;

  const repo_name = process.env.REPO;
  const repo_owner = process.env.REPO_OWNER;
  const hook_id = process.env.HOOK_ID;

  // Create an instance of `Octokit` using the token values that were set in the GitHub Actions workflow.
  // This will be used to update the configuration variable that stores the last time that this script ran.
  const MyOctokit = Octokit.plugin(paginateRest);
  const octokit = new MyOctokit({
    auth: TOKEN,
  });

  try {
    // Get the last time that this script ran from the configuration variable. If the variable is not defined, move back 5 days
    let lastWebhookRedeliveryTime = await readRedeliveryTime(LAST_REDELIVERY_FILE);
    if (lastWebhookRedeliveryTime.getTime() > 0) {
      console.log(`Loaded last redelivery time from file: ${lastWebhookRedeliveryTime}`);
    } else {
      lastWebhookRedeliveryTime = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000));
    }
    console.log(`Starting redelivery check for everything after ${lastWebhookRedeliveryTime}`);

    // Record the time that this script started redelivering webhooks.
    const newWebhookRedeliveryTime = Date.now();

    console.log(`Processing Hook ${hook_id} in ${repo_owner}/${repo_name}`);

    // Get the webhook deliveries that were delivered after `lastWebhookRedeliveryTime`.
    const deliveries = await fetchWebhookDeliveriesSince({lastWebhookRedeliveryTime, octokit, repo_owner, repo_name, hook_id});

    // Consolidate deliveries that have the same globally unique identifier (GUID). The GUID is constant across redeliveries of the same delivery.
    let deliveriesByGuid = {};
    for (const delivery of deliveries) {
      deliveriesByGuid[delivery.guid]
        ? deliveriesByGuid[delivery.guid].push(delivery)
        : (deliveriesByGuid[delivery.guid] = [delivery]);
    }

    // For each GUID value, if no deliveries for that GUID have been successfully delivered within the time frame, get the delivery ID of one of the deliveries with that GUID.
    //
    // This will prevent duplicate redeliveries if a delivery has failed multiple times.
    // This will also prevent redelivery of failed deliveries that have already been successfully redelivered.
    let failedDeliveryIDs = [];
    for (const guid in deliveriesByGuid) {
      const deliveries = deliveriesByGuid[guid];
      const anySucceeded = deliveries.some(
        (delivery) => delivery.status === "OK"
      );
      if (!anySucceeded) {
        failedDeliveryIDs.push(deliveries[0].id);
      }
    }

    // Redeliver any failed deliveries.
    for (const deliveryId of failedDeliveryIDs) {
      console.log(`Redelivering failed delivery ${deliveryId}`);
      await redeliverWebhook({deliveryId, octokit, repo_owner, repo_name, hook_id});
      await new Promise(r => setTimeout(r, SLEEP_BETWEEN_REDELIVERIES));
    }

    // Log the number of redeliveries.
    console.log(
      `Redelivered ${failedDeliveryIDs.length} failed webhook deliveries out of ${deliveries.length} total deliveries since ${lastWebhookRedeliveryTime}.`
    );

    // Update the configuration variable (or create the variable if it doesn't already exist) to store the time that this script started.
    // This value will be used next time this script runs.
    await storeRedeliveryTime(LAST_REDELIVERY_FILE, newWebhookRedeliveryTime);
  } catch (error) {
    // If there was an error, log the error so that it appears in the workflow run log, then throw the error so that the workflow run registers as a failure.
    if (error.response) {
      console.error(
        `Failed to check and redeliver webhooks: ${error.response.data.message}`
      );
    }
    console.error(error);
    throw(error);
  }
}

// This function will fetch all of the webhook deliveries that were delivered since `lastWebhookRedeliveryTime`.
// It uses the `octokit.paginate.iterator()` method to iterate through paginated results. For more information, see "[AUTOTITLE](/rest/guides/scripting-with-the-rest-api-and-javascript#making-paginated-requests)."
//
// If a page of results includes deliveries that occurred before `lastWebhookRedeliveryTime`,
// it will store only the deliveries that occurred after `lastWebhookRedeliveryTime` and then stop.
// Otherwise, it will store all of the deliveries from the page and request the next page.
async function fetchWebhookDeliveriesSince({lastWebhookRedeliveryTime, octokit, repo_owner, repo_name, hook_id}) {
  const iterator = octokit.paginate.iterator(
    "GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries",
    {
      owner: repo_owner,
      repo: repo_name,
      hook_id: hook_id,
      per_page: 100,
      headers: {
        "x-github-api-version": "2022-11-28",
      },
    }
  );

  const deliveries = [];

  for await (const { data } of iterator) {
    const oldestDeliveryTimestamp = new Date(
      data[data.length - 1].delivered_at
    ).getTime();

    if (oldestDeliveryTimestamp < lastWebhookRedeliveryTime.getTime()) {
      for (const delivery of data) {
        if (new Date(delivery.delivered_at) > lastWebhookRedeliveryTime) {
          deliveries.push(delivery);
        } else {
          break;
        }
      }
      break;
    } else {
      deliveries.push(...data);
    }
  }

  return deliveries;
}

// This function will redeliver a failed webhook delivery.
async function redeliverWebhook({deliveryId, octokit, repo_owner, repo_name, hook_id}) {
  await octokit.request("POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts", {
    owner: repo_owner,
    repo: repo_name,
    hook_id: hook_id,
    delivery_id: deliveryId,
  });
}

// This function gets the value of a configuration variable.
// If the variable does not exist, the endpoint returns a 404 response and this function returns `undefined`.
async function readRedeliveryTime(filename) {
  try {
    const data = await readFile(filename, { encoding: 'utf-8' })
    return new Date(Number(data))
  } catch (error) {
    return null;
  }
}

// This function will update a configuration variable (or create the variable if it doesn't already exist). For more information, see "[AUTOTITLE](/actions/learn-github-actions/variables#defining-configuration-variables-for-multiple-workflows)."
async function storeRedeliveryTime(filename, value) {
  await writeFile(filename, value.toString());
}

// This will execute the `checkAndRedeliverWebhooks` function.
(async () => {
  await checkAndRedeliverWebhooks();
})();
