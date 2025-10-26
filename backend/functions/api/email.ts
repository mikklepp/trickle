export async function send() {
  // TODO: Create email job and queue messages
  return {
    statusCode: 200,
    body: JSON.stringify({ jobId: "placeholder" }),
  };
}

export async function status() {
  // TODO: Get job status from DynamoDB
  return {
    statusCode: 200,
    body: JSON.stringify({ status: "pending" }),
  };
}
