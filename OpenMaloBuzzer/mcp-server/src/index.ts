#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Supabase setup — env vars or hardcoded defaults for the Buzzer project
// ---------------------------------------------------------------------------
const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "https://tlxllykthqtmsoxkmulb.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRseGxseWt0aHF0bXNveGttdWxiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NjM4NzQsImV4cCI6MjEwODIzOTg3NH0.Oxd87GbchiUEk3sdJczMhBVdX47HaycRVz3TK2UT7q0";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PushResult = "delivered" | "no_token" | "token_invalid" | "failed";

async function sendPushNotification(
  toUserId: string,
  buzzId: string,
  fromUserId: string,
  fromUserName: string,
  reason: string,
  note: string | null,
  soundId = "buzz_alarm"
): Promise<PushResult> {
  // Look up FCM token
  const { data: tokenData } = await supabase
    .from("user_tokens")
    .select("fcm_token,fcm_token_stale,token_updated_at,platform,voip_token")
    .eq("user_id", toUserId)
    .maybeSingle();

  const fcmToken = tokenData?.fcm_token;
  if (!fcmToken) return "no_token";
  if (tokenData?.fcm_token_stale) {
    const updatedAt = tokenData?.token_updated_at || 0;
    if (updatedAt > 0 && Date.now() - updatedAt < 7 * 24 * 60 * 60 * 1000) {
      await supabase
        .from("user_tokens")
        .update({ fcm_token_stale: false })
        .eq("user_id", toUserId);
    }
    // Don't block — always attempt delivery even for stale tokens.
    // If FCM returns UNREGISTERED, the token will be re-marked stale.
  }

  const payload = {
    type: "buzz",
    buzz_id: buzzId,
    from_user_id: fromUserId,
    from_user_name: fromUserName,
    reason,
    note: note || "",
    sound_id: soundId,
  };

  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fcm_token: fcmToken,
      platform: tokenData?.platform || null,
      data: payload,
      ...(tokenData?.voip_token ? { voip_token: tokenData.voip_token } : {}),
    }),
  });

  let body: any = {};
  try {
    body = await res.json();
  } catch {}

  const code = body?.error?.code;
  if (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  ) {
    await supabase
      .from("user_tokens")
      .update({ fcm_token_stale: true })
      .eq("user_id", toUserId);
    return "token_invalid";
  }

  // Track push result
  supabase
    .from("buzzes")
    .update({
      push_sent_at: Date.now(),
      push_result: res.ok ? "delivered" : "failed",
      push_attempts: 1,
    })
    .eq("id", buzzId)
    .then(() => {});

  return res.ok ? "delivered" : "failed";
}

async function sendCancelPush(
  toUserId: string,
  buzzId: string,
  fromUserName: string
): Promise<void> {
  const { data: tokenData } = await supabase
    .from("user_tokens")
    .select("fcm_token,fcm_token_stale,platform")
    .eq("user_id", toUserId)
    .maybeSingle();

  const fcmToken = tokenData?.fcm_token;
  if (!fcmToken || tokenData?.fcm_token_stale) return;

  await fetch(`${SUPABASE_URL}/functions/v1/send-notification`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fcm_token: fcmToken,
      platform: tokenData?.platform || null,
      data: {
        type: "buzz_cancelled",
        buzz_id: buzzId,
        from_user_name: fromUserName,
      },
    }),
  });
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "buzzer",
  version: "1.0.0",
});

// ---- list_users ----
server.tool(
  "list_users",
  "List all active users in the Buzzer app. Optionally filter by tenant.",
  {
    tenant_id: z.string().optional().describe("Filter by tenant ID"),
  },
  async ({ tenant_id }) => {
    let query = supabase
      .from("users")
      .select("id,name,phone,role,last_seen_at,is_active,tenant_id")
      .eq("is_active", true)
      .order("name");

    if (tenant_id) query = query.eq("tenant_id", tenant_id);

    const { data, error } = await query;
    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }

    const users = (data || []).map((u: any) => {
      const online = Date.now() - u.last_seen_at < 30_000;
      const lastSeen = formatAge(Date.now() - u.last_seen_at);
      return `- ${u.name} (${u.role}) | ID: ${u.id} | Phone: ${u.phone} | ${online ? "ONLINE" : `Last seen: ${lastSeen}`} | Tenant: ${u.tenant_id || "none"}`;
    });

    return {
      content: [
        {
          type: "text",
          text: users.length
            ? `${users.length} users:\n\n${users.join("\n")}`
            : "No users found.",
        },
      ],
    };
  }
);

// ---- list_reasons ----
server.tool(
  "list_reasons",
  "List available buzz reasons. These are the preset reason labels users pick when sending a buzz.",
  {
    tenant_id: z.string().optional().describe("Filter by tenant ID"),
  },
  async ({ tenant_id }) => {
    let query = supabase
      .from("reasons")
      .select("id,label,sort_order,tenant_id")
      .eq("is_active", true)
      .order("sort_order");

    if (tenant_id) query = query.eq("tenant_id", tenant_id);

    const { data, error } = await query;
    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }

    const reasons = (data || []).map(
      (r: any) => `- "${r.label}" (ID: ${r.id})`
    );

    return {
      content: [
        {
          type: "text",
          text: reasons.length
            ? `${reasons.length} reasons:\n\n${reasons.join("\n")}`
            : "No reasons configured.",
        },
      ],
    };
  }
);

// ---- list_groups ----
server.tool(
  "list_groups",
  "List buzz groups (collections of users that can be buzzed together).",
  {
    tenant_id: z.string().optional().describe("Filter by tenant ID"),
  },
  async ({ tenant_id }) => {
    let query = supabase
      .from("groups")
      .select("id,name,member_ids,created_by,tenant_id")
      .eq("is_active", true)
      .order("name");

    if (tenant_id) query = query.eq("tenant_id", tenant_id);

    const { data, error } = await query;
    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }

    const groups = (data || []).map(
      (g: any) =>
        `- ${g.name} | ID: ${g.id} | ${g.member_ids?.length || 0} members | Created by: ${g.created_by}`
    );

    return {
      content: [
        {
          type: "text",
          text: groups.length
            ? `${groups.length} groups:\n\n${groups.join("\n")}`
            : "No groups found.",
        },
      ],
    };
  }
);

// ---- send_buzz ----
server.tool(
  "send_buzz",
  "Send a buzz to a user. Creates the buzz in the database and sends a push notification to their device. The receiver's phone will alarm until they respond.",
  {
    from_user_id: z.string().describe("ID of the sender"),
    from_user_name: z.string().describe("Display name of the sender"),
    to_user_id: z.string().describe("ID of the user to buzz"),
    reason: z.string().describe("Reason for the buzz (e.g. 'Table 5', 'Kitchen')"),
    note: z.string().optional().describe("Optional short note (max 40 chars)"),
    tenant_id: z.string().optional().describe("Tenant ID for multi-tenancy"),
  },
  async ({ from_user_id, from_user_name, to_user_id, reason, note, tenant_id }) => {
    // Validate target user exists
    const { data: targetUser } = await supabase
      .from("users")
      .select("id,name")
      .eq("id", to_user_id)
      .eq("is_active", true)
      .maybeSingle();

    if (!targetUser) {
      return {
        content: [{ type: "text", text: `Error: User ${to_user_id} not found or inactive.` }],
      };
    }

    const buzzData = {
      from_user_id,
      from_user_name,
      to_user_id,
      reason,
      note: note || null,
      sound_id: "buzz_alarm",
      created_at: Date.now(),
      responded_at: null,
      response: "none",
      escalated: false,
      tenant_id: tenant_id || null,
    };

    const { data: buzzRow, error } = await supabase
      .from("buzzes")
      .insert(buzzData)
      .select("id")
      .single();

    if (error || !buzzRow) {
      return {
        content: [{ type: "text", text: `Error creating buzz: ${error?.message || "unknown"}` }],
      };
    }

    const buzzId = buzzRow.id;

    // Send push notification
    const pushResult = await sendPushNotification(
      to_user_id,
      buzzId,
      from_user_id,
      from_user_name,
      reason,
      note || null
    );

    return {
      content: [
        {
          type: "text",
          text: `Buzz sent to ${targetUser.name}!\n\n- Buzz ID: ${buzzId}\n- Reason: ${reason}${note ? `\n- Note: ${note}` : ""}\n- Push: ${pushResult}\n\nUse check_buzz_status to monitor the response.`,
        },
      ],
    };
  }
);

// ---- send_group_buzz ----
server.tool(
  "send_group_buzz",
  "Send a buzz to all members of a group simultaneously.",
  {
    from_user_id: z.string().describe("ID of the sender"),
    from_user_name: z.string().describe("Display name of the sender"),
    group_id: z.string().describe("ID of the group to buzz"),
    reason: z.string().describe("Reason for the buzz"),
    note: z.string().optional().describe("Optional short note (max 40 chars)"),
    tenant_id: z.string().optional().describe("Tenant ID for multi-tenancy"),
  },
  async ({ from_user_id, from_user_name, group_id, reason, note, tenant_id }) => {
    const { data: group } = await supabase
      .from("groups")
      .select("id,name,member_ids")
      .eq("id", group_id)
      .eq("is_active", true)
      .maybeSingle();

    if (!group) {
      return {
        content: [{ type: "text", text: `Error: Group ${group_id} not found.` }],
      };
    }

    const memberIds: string[] = group.member_ids || [];
    if (memberIds.length === 0) {
      return {
        content: [{ type: "text", text: `Group "${group.name}" has no members.` }],
      };
    }

    const results: string[] = [];
    const buzzIds: string[] = [];

    for (const memberId of memberIds) {
      if (memberId === from_user_id) continue; // skip sender

      const buzzData = {
        from_user_id,
        from_user_name,
        to_user_id: memberId,
        reason,
        note: note || null,
        sound_id: "buzz_alarm",
        created_at: Date.now(),
        responded_at: null,
        response: "none",
        escalated: false,
        group_id,
        group_name: group.name,
        tenant_id: tenant_id || null,
      };

      const { data: buzzRow, error } = await supabase
        .from("buzzes")
        .insert(buzzData)
        .select("id")
        .single();

      if (error || !buzzRow) {
        results.push(`- ${memberId}: FAILED (${error?.message})`);
        continue;
      }

      buzzIds.push(buzzRow.id);

      const pushResult = await sendPushNotification(
        memberId,
        buzzRow.id,
        from_user_id,
        from_user_name,
        reason,
        note || null
      );

      results.push(`- ${memberId}: buzz ${buzzRow.id} (push: ${pushResult})`);
    }

    return {
      content: [
        {
          type: "text",
          text: `Group buzz sent to "${group.name}" (${results.length} members):\n\n${results.join("\n")}\n\nBuzz IDs: ${buzzIds.join(", ")}`,
        },
      ],
    };
  }
);

// ---- check_buzz_status ----
server.tool(
  "check_buzz_status",
  "Check the response status of a buzz. Returns whether the receiver has acknowledged, is busy, etc.",
  {
    buzz_id: z.string().describe("The buzz ID to check"),
  },
  async ({ buzz_id }) => {
    const { data: buzz, error } = await supabase
      .from("buzzes")
      .select("*")
      .eq("id", buzz_id)
      .maybeSingle();

    if (error || !buzz) {
      return {
        content: [{ type: "text", text: `Buzz ${buzz_id} not found.` }],
      };
    }

    const responseLabels: Record<string, string> = {
      none: "No response yet (waiting)",
      ack: "Acknowledged — coming!",
      five_min: "Will be there in 5 minutes",
      busy: "Busy — cannot come now",
      cancelled: "Cancelled by sender",
      dismissed: "Dismissed by receiver",
      auto_dismissed: "Auto-dismissed (receiver may not have seen it)",
    };

    const age = formatAge(Date.now() - buzz.created_at);
    const respondedAge = buzz.responded_at
      ? formatAge(Date.now() - buzz.responded_at)
      : null;

    const lines = [
      `Buzz: ${buzz.id}`,
      `From: ${buzz.from_user_name || buzz.from_user_id}`,
      `To: ${buzz.to_user_id}`,
      `Reason: ${buzz.reason}`,
      buzz.note ? `Note: ${buzz.note}` : null,
      `Sent: ${age}`,
      `Response: ${responseLabels[buzz.response] || buzz.response}`,
      respondedAge ? `Responded: ${respondedAge}` : null,
      buzz.escalated ? "Escalated: Yes" : null,
      buzz.group_name ? `Group: ${buzz.group_name}` : null,
      `Push: ${buzz.push_result || "not tracked"}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { content: [{ type: "text", text: lines }] };
  }
);

// ---- cancel_buzz ----
server.tool(
  "cancel_buzz",
  "Cancel a pending buzz. Stops the alarm on the receiver's device.",
  {
    buzz_id: z.string().describe("The buzz ID to cancel"),
    cancelled_by_name: z.string().describe("Name of the person cancelling"),
  },
  async ({ buzz_id, cancelled_by_name }) => {
    // Get the buzz first
    const { data: buzz, error: fetchErr } = await supabase
      .from("buzzes")
      .select("id,to_user_id,response,from_user_name")
      .eq("id", buzz_id)
      .maybeSingle();

    if (fetchErr || !buzz) {
      return {
        content: [{ type: "text", text: `Buzz ${buzz_id} not found.` }],
      };
    }

    if (buzz.response !== "none" && buzz.response !== "auto_dismissed") {
      return {
        content: [
          {
            type: "text",
            text: `Buzz already has response: "${buzz.response}". Cannot cancel.`,
          },
        ],
      };
    }

    // Update response to cancelled
    const { error: updateErr } = await supabase
      .from("buzzes")
      .update({ response: "cancelled", responded_at: Date.now() })
      .eq("id", buzz_id);

    if (updateErr) {
      return {
        content: [{ type: "text", text: `Error cancelling: ${updateErr.message}` }],
      };
    }

    // Send cancellation push to stop alarm
    await sendCancelPush(
      buzz.to_user_id,
      buzz_id,
      cancelled_by_name
    );

    return {
      content: [
        {
          type: "text",
          text: `Buzz ${buzz_id} cancelled. Cancellation push sent to receiver.`,
        },
      ],
    };
  }
);

// ---- get_recent_buzzes ----
server.tool(
  "get_recent_buzzes",
  "Get recent buzzes sent by or to a user. Useful for reviewing buzz history.",
  {
    user_id: z.string().describe("User ID to query buzzes for"),
    direction: z
      .enum(["sent", "received"])
      .default("sent")
      .describe("Whether to get buzzes sent BY or received BY this user"),
    limit: z.number().default(10).describe("Max number of buzzes to return"),
  },
  async ({ user_id, direction, limit }) => {
    const col = direction === "sent" ? "from_user_id" : "to_user_id";

    const { data, error } = await supabase
      .from("buzzes")
      .select("*")
      .eq(col, user_id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }

    if (!data || data.length === 0) {
      return {
        content: [{ type: "text", text: `No buzzes found (${direction} by ${user_id}).` }],
      };
    }

    const responseLabels: Record<string, string> = {
      none: "waiting",
      ack: "ACK",
      five_min: "5min",
      busy: "busy",
      cancelled: "cancelled",
      dismissed: "dismissed",
      auto_dismissed: "auto-dismissed",
    };

    const lines = data.map((b: any) => {
      const age = formatAge(Date.now() - b.created_at);
      const resp = responseLabels[b.response] || b.response;
      const target =
        direction === "sent"
          ? `-> ${b.to_user_id}`
          : `<- ${b.from_user_name || b.from_user_id}`;
      return `- ${age} | ${target} | "${b.reason}" | ${resp}${b.group_name ? ` | Group: ${b.group_name}` : ""} | ID: ${b.id}`;
    });

    return {
      content: [
        {
          type: "text",
          text: `${data.length} recent buzzes (${direction}):\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// ---- get_pending_buzzes ----
server.tool(
  "get_pending_buzzes",
  "Get all buzzes that have not been responded to yet (response is 'none' or 'auto_dismissed'). Useful for finding unanswered buzzes.",
  {
    tenant_id: z.string().optional().describe("Filter by tenant ID"),
  },
  async ({ tenant_id }) => {
    let query = supabase
      .from("buzzes")
      .select("*")
      .in("response", ["none", "auto_dismissed"])
      .order("created_at", { ascending: false })
      .limit(50);

    if (tenant_id) query = query.eq("tenant_id", tenant_id);

    const { data, error } = await query;
    if (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }

    if (!data || data.length === 0) {
      return { content: [{ type: "text", text: "No pending buzzes." }] };
    }

    const lines = data.map((b: any) => {
      const age = formatAge(Date.now() - b.created_at);
      return `- ${age} | ${b.from_user_name || b.from_user_id} -> ${b.to_user_id} | "${b.reason}" | ${b.response} | Push: ${b.push_result || "?"} | ID: ${b.id}`;
    });

    return {
      content: [
        {
          type: "text",
          text: `${data.length} pending buzzes:\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
