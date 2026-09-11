// Stand-in for `qodercli --print --input-format stream-json` answering get_usage_info.
import readline from "node:readline";

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request" || message.request?.subtype !== "get_usage_info") return;
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          usage: {
            userType: "pro",
            expiresAt: Date.now() + 20 * 86400_000,
            userQuota: { total: 1000, used: 900, remaining: 100, unit: "credits" },
          },
        },
      },
    })}\n`,
  );
});
