import { AppSyncResolverEvent } from "aws-lambda";
import { sendMessage } from "./sendMessage";
import { parse } from "node-html-parser";
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { LambdaHandler, createHandler } from "./types";
import got from "got";

interface Config {
  dynamoClient: DynamoDBClient;
  ssmClient: SSMClient;
}

const KAUAI_ID = 1692;
const START_DATE = "20230521";
const DAYS_TO_SEARCH = 5;

export const napaliAvailabilityHandler: LambdaHandler<
  AppSyncResolverEvent<void>,
  Config,
  void
> = async (event, context, { dynamoClient, ssmClient }) => {
  // Request the data from their API in their strange format
  const { body } = await got.get(
    `https://camping.ehawaii.gov/camping/all,sites,0,25,1,${KAUAI_ID},,,,${START_DATE},${DAYS_TO_SEARCH},,,1,1683343883421.html`
  );

  // Find the date names from the table header row
  const dateNames = parse(body)
    .querySelector("thead")
    ?.querySelector("tr")
    ?.querySelectorAll("th")
    ?.slice(-DAYS_TO_SEARCH)
    ?.map((el) => el.text.trim());
  if (dateNames?.length !== DAYS_TO_SEARCH) {
    throw Error("Failed to find names for all dates");
  }

  // Find the row for the Kalalau trail permits and organize the data
  const tableBody = parse(body).querySelector("tbody");
  const row = tableBody
    ?.querySelectorAll("tr")
    ?.map((row) => {
      const cells = row.querySelectorAll("td").map((cell) => cell.text.trim());
      return {
        campsiteName: cells[0],
        availability: cells
          .slice(-DAYS_TO_SEARCH)
          .map((cell) => parseInt(cell, 10))
          // Some cells have letters like 'C', so parseInt will sometimes be Nan.
          .map((available) => (isNaN(available) ? 0 : available))
          .map((available, i) => ({
            available,
            date: dateNames[i] ?? `Day ${i}`,
          })),
      };
    })
    ?.find((row) => row.campsiteName === "Kalalau");
  if (row?.availability?.length !== DAYS_TO_SEARCH) {
    throw Error("Could not find the expected row for Kalalau permits");
  }
  console.log(`Found availability: ${JSON.stringify(row, null, 2)}`);

  // Lookup the results from the most recent run so we can avoid spamming texts unless things have changed
  const { Items: KnownInfoItems } = await dynamoClient.send(
    new ScanCommand({
      TableName: process.env.KNOWN_INFO_TABLE,
    })
  );
  const knownInfoMap = new Map<string, number>();
  KnownInfoItems?.forEach((row) => {
    const key = row["date"]?.S;
    const availability = parseInt(row["availability"]?.N ?? "0", 10);
    if (!key || isNaN(availability)) {
      throw Error(`Found invalid data for row ${row}`);
    }
    knownInfoMap.set(key, availability);
  });
  console.log(
    `Found availability from previous run: ${JSON.stringify(
      Array.from(knownInfoMap.entries()),
      null,
      2
    )}`
  );

  // Exit if there is no new information
  if (
    row.availability.every(
      ({ available, date }) => knownInfoMap.get(date) === available
    )
  ) {
    console.log(`There is no new information, exiting.`);
    return;
  }

  // Update the database with these latest values
  console.log("Updating database with new values");
  await Promise.all(
    row.availability.map((info) =>
      dynamoClient.send(
        new UpdateItemCommand({
          TableName: process.env.KNOWN_INFO_TABLE,
          Key: { date: { S: `${info.date}` } },
          UpdateExpression: "SET #a = :val",
          ExpressionAttributeNames: {
            "#a": "availability",
          },
          ExpressionAttributeValues: {
            ":val": { N: info.available.toString() },
          },
        })
      )
    )
  );

  // Exit if there are no available permits
  if (row.availability.every(({ available }) => available === 0)) {
    console.log(`There is no availability, exiting.`);
    return;
  }

  // Write and send a nicely formatted message if things changed and dates are available
  const availabilitySection = row.availability
    .filter(({ available }) => available > 0)
    .map(
      ({ date, available }) =>
        `- ${date}: ${available} permit${available === 1 ? "" : "s"}`
    )
    .join("\n");

  const message = `
Beep-boop. Some availability has changed on the Napali trail.

${availabilitySection}

You can claim a permit here: https://camping.ehawaii.gov/camping/all,details,${KAUAI_ID}.html
    `.trim();

  await sendMessage(ssmClient, message);
};

export const napaliAvailability = createHandler(
  napaliAvailabilityHandler,
  () => ({
    dynamoClient: new DynamoDBClient({}),
    ssmClient: new SSMClient({}),
  })
);
