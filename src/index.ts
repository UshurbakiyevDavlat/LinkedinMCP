#!/usr/bin/env node
/**
 * LinkedIn MCP Server
 *
 * Provides tools to:
 *  - Post content (text, images, articles) to LinkedIn
 *  - Read and update your LinkedIn profile
 *  - Retrieve analytics for organization pages and posts
 *
 * Auth: set LINKEDIN_ACCESS_TOKEN env var with an OAuth 2.0 Bearer token.
 * Required scopes:
 *   - profile          (read profile)
 *   - w_member_social  (create/delete posts)
 *   - r_organization_social (org analytics — optional)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import fs from "fs";
import http from "http";

import { v2Request, restRequest, handleApiError, uploadImage, oidcUserInfo, restMe } from "./services/linkedin.js";
import { ResponseFormat, POST_MAX_LENGTH } from "./constants.js";
import type {
  LinkedInProfile,
  LinkedInPost,
  LinkedInPosition,
  LinkedInOrgAnalytics,
  LinkedInPostAnalytics,
} from "./types.js";

// ─────────────────────────────────────────────
// Server instance
// ─────────────────────────────────────────────

const server = new McpServer({
  name: "linkedin-mcp-server",
  version: "1.0.0",
});

// ─────────────────────────────────────────────
// Shared Zod schemas
// ─────────────────────────────────────────────

const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

// ─────────────────────────────────────────────
// PROFILE TOOLS
// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_get_profile",
  {
    title: "Get LinkedIn Profile",
    description: `Retrieve the authenticated user's LinkedIn profile information.

Returns: id, first name, last name, headline, vanity URL, and profile picture.

Required scope: profile

Examples:
  - "Show me my LinkedIn profile"
  - "What's my LinkedIn headline?"`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }) => {
    try {
      // /v2/userinfo — OIDC endpoint, works with openid + profile scopes
      const userInfo = await oidcUserInfo();

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(userInfo, null, 2) }] };
      }

      const lines = [
        `# LinkedIn Profile`,
        ``,
        `**Name**: ${userInfo.name}`,
        `**First Name**: ${userInfo.given_name}`,
        `**Last Name**: ${userInfo.family_name}`,
        userInfo.email ? `**Email**: ${userInfo.email}` : "",
        `**ID**: ${userInfo.sub}`,
        userInfo.picture ? `**Photo**: ${userInfo.picture}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_get_positions",
  {
    title: "Get LinkedIn Profile Positions",
    description: `Retrieve the work experience / positions listed on the authenticated user's LinkedIn profile.

Returns a list of positions with title, company, dates, and location.

Required scope: profile

Examples:
  - "List my work experience on LinkedIn"
  - "What jobs do I have listed on my profile?"`,
    inputSchema: z.object({
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }) => {
    try {
      const data = await v2Request<{ elements: LinkedInPosition[] }>(
        "me/positions?projection=(id,title,companyName,locationName,startMonthYear,endMonthYear,current,description)"
      );

      const positions = data.elements ?? [];

      if (!positions.length) {
        return { content: [{ type: "text", text: "No positions found on your LinkedIn profile." }] };
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(positions, null, 2) }] };
      }

      const lines = [`# LinkedIn Positions (${positions.length})`, ``];
      for (const pos of positions) {
        const start = pos.startMonthYear
          ? `${pos.startMonthYear.month}/${pos.startMonthYear.year}`
          : "—";
        const end = pos.current ? "Present" : pos.endMonthYear
          ? `${pos.endMonthYear.month}/${pos.endMonthYear.year}`
          : "—";
        lines.push(`## ${pos.title} @ ${pos.companyName ?? "Unknown Company"}`);
        lines.push(`- **Period**: ${start} – ${end}`);
        if (pos.locationName) lines.push(`- **Location**: ${pos.locationName}`);
        if (pos.description) lines.push(`- **Description**: ${pos.description}`);
        lines.push(``);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_update_position",
  {
    title: "Update LinkedIn Position",
    description: `Update an existing work position on your LinkedIn profile.

Only positions previously created via the API (with numeric IDs) can be updated.
You can change title, end date, current status, location, and description.

Required scope: w_member_social (or profile edit — see LinkedIn docs)

Args:
  - position_id (string): Numeric ID of the position to update
  - title (string, optional): New job title
  - end_month (number, optional): End month (1-12). Ignored if current is true
  - end_year (number, optional): End year. Ignored if current is true
  - current (boolean, optional): Mark as current position
  - location_name (string, optional): Location string (e.g. "San Francisco, CA")
  - description (string, optional): Description / summary of the role

Examples:
  - "Mark my Developer position as ended in Dec 2024"
  - "Update the description of position 123456"`,
    inputSchema: z.object({
      position_id: z.string().describe("Numeric ID of the position to update"),
      title: z.string().optional().describe("New job title"),
      end_month: z.number().int().min(1).max(12).optional().describe("End month (1–12)"),
      end_year: z.number().int().min(1900).max(2100).optional().describe("End year"),
      current: z.boolean().optional().describe("Whether this is the current position"),
      location_name: z.string().optional().describe("Location string"),
      description: z.string().optional().describe("Role description"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ position_id, title, end_month, end_year, current, location_name, description }) => {
    try {
      const patch: Record<string, unknown> = { patch: { $set: {} } };
      const $set = patch.patch as { $set: Record<string, unknown> };

      if (title !== undefined) $set.$set.title = title;
      if (current !== undefined) $set.$set.current = current;
      if (location_name !== undefined) $set.$set.locationName = location_name;
      if (description !== undefined) $set.$set.description = description;
      if (!current && end_month !== undefined && end_year !== undefined) {
        $set.$set.endMonthYear = { month: end_month, year: end_year };
      }

      await v2Request(`me/positions/${position_id}`, "PATCH", patch);

      return {
        content: [{ type: "text", text: `✅ Position ${position_id} updated successfully.` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// POSTING TOOLS
// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_create_post",
  {
    title: "Create LinkedIn Post",
    description: `Create a new post on LinkedIn. Supports text-only posts and posts with a previously uploaded image.

The post is published immediately as the authenticated user.

Required scope: w_member_social

Args:
  - text (string): Post text content. Max ${POST_MAX_LENGTH} characters.
  - visibility (string, optional): 'PUBLIC' (default) or 'CONNECTIONS'
  - image_urn (string, optional): Image URN from linkedin_upload_image. Include to attach an image.
  - image_title (string, optional): Alt-text / title for the attached image

Returns: The created post URN (e.g. urn:li:share:1234567890)

Examples:
  - "Post 'Hello World!' to LinkedIn"
  - "Share an image with caption 'Exciting news!'"
  - Don't use when: You need to post on behalf of an organization (use organization author)`,
    inputSchema: z.object({
      text: z
        .string()
        .min(1, "Post text cannot be empty")
        .max(POST_MAX_LENGTH, `Post text must be at most ${POST_MAX_LENGTH} characters`)
        .describe("Post text content"),
      visibility: z
        .enum(["PUBLIC", "CONNECTIONS"])
        .default("PUBLIC")
        .describe("Who can see the post: PUBLIC or CONNECTIONS"),
      image_urn: z
        .string()
        .optional()
        .describe("Image URN from linkedin_upload_image (e.g. urn:li:image:...)"),
      image_title: z.string().optional().describe("Alt-text / title for the attached image"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ text, visibility, image_urn, image_title }) => {
    try {
      // Get the user's person URN first
      const me = await v2Request<LinkedInProfile>("me");
      const authorUrn = `urn:li:person:${me.id}`;

      const body: Record<string, unknown> = {
        author: authorUrn,
        commentary: text,
        visibility,
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };

      if (image_urn) {
        body.content = {
          media: {
            id: image_urn,
            ...(image_title ? { title: image_title } : {}),
          },
        };
      }

      const result = await restRequest<Record<string, unknown>>("posts", "POST", body);
      // LinkedIn returns the post URN in the x-restli-id response header
      const postId = result.headers["x-restli-id"] ?? result.headers["location"] ?? "unknown";

      return {
        content: [
          {
            type: "text",
            text: `✅ Post created successfully!\n\n**Post URN**: ${postId}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_get_post",
  {
    title: "Get LinkedIn Post",
    description: `Retrieve details of a specific LinkedIn post by its URN.

Required scope: w_member_social (or r_member_social if available)

Args:
  - post_urn (string): The full post URN (e.g. urn:li:share:1234567890 or urn:li:ugcPost:...)

Returns: Post text, author, visibility, lifecycle state, timestamps.

Examples:
  - "Get details of my post urn:li:share:1234567890"`,
    inputSchema: z.object({
      post_urn: z
        .string()
        .describe("Full post URN (e.g. urn:li:share:1234567890 or urn:li:ugcPost:...)"),
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ post_urn, response_format }) => {
    try {
      const encodedUrn = encodeURIComponent(post_urn);
      const result = await restRequest<LinkedInPost>(`posts/${encodedUrn}`);
      const post = result.data;

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(post, null, 2) }] };
      }

      const created = post.createdAt
        ? new Date(post.createdAt).toLocaleString()
        : "—";
      const lines = [
        `# LinkedIn Post`,
        ``,
        `**URN**: ${post.id}`,
        `**Author**: ${post.author}`,
        `**Visibility**: ${post.visibility}`,
        `**State**: ${post.lifecycleState}`,
        `**Created**: ${created}`,
        ``,
        `**Text**:`,
        post.commentary ?? "_(no text)_",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_delete_post",
  {
    title: "Delete LinkedIn Post",
    description: `Delete a LinkedIn post by its URN. This action is irreversible.

Required scope: w_member_social

Args:
  - post_urn (string): The full post URN (e.g. urn:li:share:1234567890)

Examples:
  - "Delete my LinkedIn post urn:li:share:1234567890"`,
    inputSchema: z.object({
      post_urn: z
        .string()
        .describe("Full post URN to delete (e.g. urn:li:share:1234567890)"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ post_urn }) => {
    try {
      const encodedUrn = encodeURIComponent(post_urn);
      await restRequest(`posts/${encodedUrn}`, "DELETE");
      return {
        content: [{ type: "text", text: `✅ Post ${post_urn} deleted successfully.` }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_upload_image",
  {
    title: "Upload Image to LinkedIn",
    description: `Upload a local image file to LinkedIn and obtain an Image URN for use in posts.

After uploading, use the returned image_urn with linkedin_create_post to attach the image.

Required scope: w_member_social

Args:
  - file_path (string): Absolute path to the image file on disk (JPEG or PNG)

Returns: image_urn — the URN to pass to linkedin_create_post

Examples:
  - "Upload /Users/me/photo.jpg and post it with text 'Great event!'"`,
    inputSchema: z.object({
      file_path: z
        .string()
        .describe("Absolute path to the local image file (JPEG or PNG)"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ file_path }) => {
    try {
      if (!fs.existsSync(file_path)) {
        return {
          content: [{ type: "text", text: `Error: File not found at path: ${file_path}` }],
          isError: true,
        };
      }

      const ext = file_path.toLowerCase().split(".").pop();
      const mimeType =
        ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : null;
      if (!mimeType) {
        return {
          content: [{ type: "text", text: "Error: Only JPEG (.jpg/.jpeg) and PNG (.png) images are supported." }],
          isError: true,
        };
      }

      const imageBuffer = fs.readFileSync(file_path);

      // Get user URN
      const me = await v2Request<LinkedInProfile>("me");
      const personUrn = `urn:li:person:${me.id}`;

      const imageUrn = await uploadImage(personUrn, imageBuffer, mimeType);

      return {
        content: [
          {
            type: "text",
            text: `✅ Image uploaded successfully!\n\n**Image URN**: ${imageUrn}\n\nUse this URN with \`linkedin_create_post\` (image_urn parameter).`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// ANALYTICS TOOLS
// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_get_org_analytics",
  {
    title: "Get Organization Page Analytics",
    description: `Retrieve page view statistics for a LinkedIn organization (company) page.

Note: This tool requires the r_organization_social OAuth scope and that the authenticated user
is an admin of the organization. LinkedIn analytics are only available for organization pages,
not for personal profiles.

Args:
  - org_urn (string): Organization URN (e.g. urn:li:organization:12345678)
  - start_date (string, optional): Start date in YYYY-MM-DD format (defaults to 30 days ago)
  - end_date (string, optional): End date in YYYY-MM-DD format (defaults to today)
  - response_format: 'markdown' or 'json'

Returns: Page views (total, mobile, desktop), follower statistics.

Examples:
  - "Show me analytics for my company page urn:li:organization:12345678"
  - "How many page views did we get last month?"`,
    inputSchema: z.object({
      org_urn: z
        .string()
        .describe("Organization URN (e.g. urn:li:organization:12345678)"),
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
        .optional()
        .describe("Start date in YYYY-MM-DD format (default: 30 days ago)"),
      end_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
        .optional()
        .describe("End date in YYYY-MM-DD format (default: today)"),
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ org_urn, start_date, end_date, response_format }) => {
    try {
      const now = new Date();
      const endMs = end_date
        ? new Date(end_date).getTime()
        : now.getTime();
      const startMs = start_date
        ? new Date(start_date).getTime()
        : now.getTime() - 30 * 24 * 60 * 60 * 1000;

      const params: Record<string, unknown> = {
        q: "organization",
        organization: org_urn,
        "timeIntervals.timeGranularityType": "MONTH",
        "timeIntervals.timeRange.start": startMs,
        "timeIntervals.timeRange.end": endMs,
      };

      const result = await v2Request<{ elements: LinkedInOrgAnalytics[] }>(
        "organizationPageStatistics",
        "GET",
        undefined,
        params
      );

      const elements = result.elements ?? [];

      if (!elements.length) {
        return {
          content: [
            { type: "text", text: "No analytics data found for the given organization and date range." },
          ],
        };
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(elements, null, 2) }] };
      }

      const lines = [`# Organization Page Analytics`, `**Org**: ${org_urn}`, ``];
      for (const el of elements) {
        const views = el.totalPageStatistics?.views;
        const allViews = views?.allPageViews?.pageViews ?? 0;
        const mobileViews = views?.mobilePageViews?.pageViews ?? 0;
        const desktopViews = views?.desktopPageViews?.pageViews ?? 0;
        const period = el.timeRange
          ? `${new Date(el.timeRange.start).toLocaleDateString()} – ${new Date(el.timeRange.end).toLocaleDateString()}`
          : "All time";
        lines.push(`## Period: ${period}`);
        lines.push(`- **Total views**: ${allViews.toLocaleString()}`);
        lines.push(`- **Mobile views**: ${mobileViews.toLocaleString()}`);
        lines.push(`- **Desktop views**: ${desktopViews.toLocaleString()}`);
        lines.push(``);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────

server.registerTool(
  "linkedin_get_post_analytics",
  {
    title: "Get LinkedIn Post Analytics",
    description: `Retrieve engagement statistics for your LinkedIn posts.

Returns impressions, clicks, likes, comments, shares, and engagement rate for each post.

Note: Requires r_organization_social or r_member_social scope.
LinkedIn may restrict access to post-level analytics to approved Marketing API partners.

Args:
  - author_urn (string, optional): Limit to posts by this author URN. Defaults to your own person URN.
  - limit (number, optional): Max posts to retrieve stats for (default: 10, max: 50)
  - response_format: 'markdown' or 'json'

Examples:
  - "Show me the performance of my recent LinkedIn posts"
  - "What are the impressions on my posts?"`,
    inputSchema: z.object({
      author_urn: z
        .string()
        .optional()
        .describe("Author URN (defaults to your own urn:li:person:...)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max number of posts to retrieve analytics for"),
      response_format: ResponseFormatSchema,
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ author_urn, limit, response_format }) => {
    try {
      let personUrn = author_urn;
      if (!personUrn) {
        const me = await v2Request<LinkedInProfile>("me");
        personUrn = `urn:li:person:${me.id}`;
      }

      const params: Record<string, unknown> = {
        q: "author",
        author: personUrn,
        count: limit,
      };

      const result = await v2Request<{ elements: LinkedInPostAnalytics[] }>(
        "memberCreatorPostAnalytics",
        "GET",
        undefined,
        params
      );

      const posts = result.elements ?? [];

      if (!posts.length) {
        return {
          content: [
            {
              type: "text",
              text: "No post analytics found. This may require the r_organization_social or Marketing API access.",
            },
          ],
        };
      }

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(posts, null, 2) }] };
      }

      const lines = [`# Post Analytics (${posts.length} posts)`, ``];
      for (const post of posts) {
        const stats = post.totalShareStatistics;
        const urn = post.ugcPostShare ?? "—";
        lines.push(`## Post: ${urn}`);
        if (stats) {
          lines.push(`- **Impressions**: ${stats.impressionCount?.toLocaleString() ?? 0}`);
          lines.push(`- **Clicks**: ${stats.clickCount?.toLocaleString() ?? 0}`);
          lines.push(`- **Likes**: ${stats.likeCount?.toLocaleString() ?? 0}`);
          lines.push(`- **Comments**: ${stats.commentCount?.toLocaleString() ?? 0}`);
          lines.push(`- **Shares**: ${stats.shareCount?.toLocaleString() ?? 0}`);
          lines.push(`- **Engagement**: ${(stats.engagement * 100).toFixed(2)}%`);
        }
        lines.push(``);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleApiError(error) }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

async function main() {
  if (!process.env.LINKEDIN_ACCESS_TOKEN) {
    console.error(
      "ERROR: LINKEDIN_ACCESS_TOKEN environment variable is required.\n" +
      "  1. Create a LinkedIn app at https://developer.linkedin.com\n" +
      "  2. Request scopes: profile, w_member_social, r_organization_social\n" +
      "  3. Complete the OAuth flow and set the access token:\n" +
      "     export LINKEDIN_ACCESS_TOKEN=<your_token>"
    );
    process.exit(1);
  }

  const transportMode = process.env.MCP_TRANSPORT ?? "stdio";

  if (transportMode === "sse") {
    // ── SSE / HTTP mode (for VPS / remote access) ──────────────────────────
    const PORT = parseInt(process.env.PORT ?? "3100", 10);
    const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN; // optional token guard

    const activeSessions: Record<string, SSEServerTransport> = {};

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`);

      // ── GET /sse — open SSE stream ────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/sse") {
        // Token check (if MCP_AUTH_TOKEN is set)
        if (AUTH_TOKEN && url.searchParams.get("token") !== AUTH_TOKEN) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }

        const transport = new SSEServerTransport("/messages", res);
        activeSessions[transport.sessionId] = transport;

        req.on("close", () => {
          delete activeSessions[transport.sessionId];
        });

        await server.connect(transport);
        return;
      }

      // ── POST /messages — client → server messages ─────────────────────────
      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const transport = activeSessions[sessionId];

        if (!transport) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }

        // Pass raw req directly — SDK reads the body stream itself
        await transport.handlePostMessage(req, res);
        return;
      }

      // ── CORS preflight ────────────────────────────────────────────────────
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // ── Health check ──────────────────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "linkedin-mcp-server" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    httpServer.listen(PORT, () => {
      console.error(`LinkedIn MCP server running in SSE mode on port ${PORT}`);
      console.error(`  SSE endpoint:  http://localhost:${PORT}/sse`);
      console.error(`  Health check:  http://localhost:${PORT}/health`);
      if (AUTH_TOKEN) {
        console.error(`  Auth token:    set (use ?token=... query param)`);
      }
    });
  } else {
    // ── stdio mode (default — for local Claude Desktop) ───────────────────
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("LinkedIn MCP server running via stdio");
  }
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
