export async function get() {
  // TODO: Get user config from DynamoDB
  return {
    statusCode: 200,
    body: JSON.stringify({ rateLimit: 60 }),
  };
}

export async function update() {
  // TODO: Update user config in DynamoDB
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Config updated" }),
  };
}
