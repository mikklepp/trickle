export async function list() {
  // TODO: Fetch verified SES identities
  return {
    statusCode: 200,
    body: JSON.stringify({ senders: [] }),
  };
}
