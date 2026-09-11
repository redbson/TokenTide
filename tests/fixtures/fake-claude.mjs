// Stand-in for `claude -p --input-format stream-json` answering the get_usage control request.
import readline from "node:readline";

const inHours = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type !== "control_request" || message.request?.subtype !== "get_usage") return;
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: {
          subscription_type: "pro",
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 25, resets_at: inHours(2) }, seven_day: { utilization: 60, resets_at: inHours(100) } },
        },
      },
    })}\n`,
  );
});
