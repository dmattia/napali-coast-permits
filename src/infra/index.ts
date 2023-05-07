import * as aws from "@pulumi/aws";
import { LambdaCron } from "./LambdaCron";

// A very basic table where each row has a `date` field and an `availability` field
const knownAvailability = new aws.dynamodb.Table("knownAvailability", {
  billingMode: "PAY_PER_REQUEST",
  pointInTimeRecovery: { enabled: false },
  serverSideEncryption: { enabled: true },
  name: "napaliKnownAvailability",
  attributes: [{ name: "date", type: "S" }],
  hashKey: "date",
});

// Create Twilio secrets to be accessed in the lambda
const twilioSecrets = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
  "RECIPIENT_NUMBERS",
].map(
  (name) =>
    new aws.ssm.Parameter(name, {
      name: `napali_${name}`,
      type: "SecureString",
      value: process.env[name]!,
    })
);

// Create scheduled cron jobs
new LambdaCron("napaliCampgrounds", {
  name: "napaliAvailability",
  entrypoint: "@napali/main/src/napaliAvailability",
  iamPermissions: [
    {
      Action: [
        "dynamodb:scan",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
      ],
      Resource: [knownAvailability.arn],
      Effect: "Allow",
    },
    {
      Action: ["ssm:GetParameters"],
      Resource: twilioSecrets.map((secret) => secret.arn),
      Effect: "Allow",
    },
  ],
  schedule: "rate(1 minute)",
  environment: {
    KNOWN_INFO_TABLE: knownAvailability.name,
  },
  overrides: { timeout: 50 },
});
