// Server-side automatic retry for failed buzz pushes.
// Called by pg_cron every minute. Finds buzzes where push failed
// but receiver hasn't responded yet, and re-sends the push.
// DEDUP SAFETY:
//   - Only retries buzzes with push_result = 'failed' (never 'delivered')
//   - Only retries buzzes older than 30s (gives initial push time to arrive)
//   - Re-checks response right before sending (catches late responses)
//   - iOS: BuzzerCallManager.lastReportedBuzzId prevents duplicate CallKit
//   - Android: BuzzerService.isBuzzSeen prevents duplicate alarm

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (_req) => {
  try {
    // Only retry buzzes that are:
    // - 30s to 10min old (too fresh = initial push still in flight; too old = stale)
    // - push_result = 'failed' (never retry 'delivered' — would cause duplicates)
    // - response = 'none' (receiver hasn't responded yet)
    const now = Date.now();
    const minAge = now - 10 * 60 * 1000; // 10 min ago
    const maxAge = now - 30 * 1000;       // 30 sec ago
    const buzzesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/buzzes?response=eq.none&push_result=eq.failed&created_at=gte.${minAge}&created_at=lte.${maxAge}&select=id,from_user_id,from_user_name,to_user_id,reason,note,sound_id,push_attempts,response&order=created_at.desc&limit=5`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!buzzesRes.ok) {
      return new Response(JSON.stringify({ error: "Failed to query buzzes" }), { status: 500 });
    }

    const buzzes = await buzzesRes.json();
    if (!buzzes || buzzes.length === 0) {
      return new Response(JSON.stringify({ retried: 0 }), { status: 200 });
    }

    let retried = 0;

    for (const buzz of buzzes) {
      // Re-check response right before sending — user may have responded
      // between the query and now (race window).
      const checkRes = await fetch(
        `${SUPABASE_URL}/rest/v1/buzzes?id=eq.${buzz.id}&select=response`,
        {
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      if (checkRes.ok) {
        const rows = await checkRes.json();
        if (rows?.[0]?.response && rows[0].response !== "none" && rows[0].response !== "auto_dismissed") {
          console.log(`Buzz ${buzz.id} already responded (${rows[0].response}) — skipping retry`);
          continue;
        }
      }

      // Max 3 server retries to avoid infinite push spam
      if ((buzz.push_attempts || 0) >= 8) {
        console.log(`Buzz ${buzz.id} exceeded max retries (${buzz.push_attempts}) — giving up`);
        continue;
      }

      // Get receiver's token
      const tokenRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_tokens?user_id=eq.${buzz.to_user_id}&select=fcm_token,platform,voip_token`,
        {
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );

      if (!tokenRes.ok) continue;
      const tokens = await tokenRes.json();
      if (!tokens || tokens.length === 0) continue;
      const tokenData = tokens[0];
      if (!tokenData.fcm_token && !tokenData.voip_token) continue;

      // Re-send push
      try {
        const pushRes = await fetch(
          `${SUPABASE_URL}/functions/v1/send-notification`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              fcm_token: tokenData.fcm_token,
              voip_token: tokenData.voip_token || null,
              platform: tokenData.platform,
              data: {
                type: "buzz",
                buzz_id: buzz.id,
                from_user_id: buzz.from_user_id || "",
                from_user_name: buzz.from_user_name || "User",
                reason: buzz.reason || "",
                note: buzz.note || "",
                sound_id: buzz.sound_id || "buzz_alarm",
              },
            }),
          }
        );

        const pushResult = pushRes.ok ? "delivered" : "failed";

        // Update push tracking
        await fetch(
          `${SUPABASE_URL}/rest/v1/buzzes?id=eq.${buzz.id}`,
          {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
            body: JSON.stringify({
              push_result: pushResult,
              push_sent_at: Date.now(),
              push_attempts: (buzz.push_attempts || 0) + 1,
            }),
          }
        );

        if (pushRes.ok) retried++;
        console.log(`Retry buzz ${buzz.id}: ${pushResult} (attempt ${(buzz.push_attempts || 0) + 1})`);
      } catch (e) {
        console.error(`Retry buzz ${buzz.id} error:`, e);
      }
    }

    return new Response(JSON.stringify({ retried, total: buzzes.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
