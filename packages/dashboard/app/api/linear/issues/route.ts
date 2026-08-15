import { NextResponse, type NextRequest } from "next/server";
import { LinearSource, type LinearIssueFixture } from "@pros/triggers";
import { filterLinearTickets, type LinearTicket } from "../../../../lib/linear";

export const dynamic = "force-dynamic";

/** Read-only Linear issue browser. It never creates, updates, or comments. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const team = params.get("team")?.trim() || undefined;
  const search = params.get("search")?.trim() || undefined;
  const status = params.get("status")?.trim() || undefined;
  const label = params.get("label")?.trim() || undefined;

  try {
    const source = new LinearSource({
      team,
      search,
      status,
      apiUrl: process.env.PROS_LINEAR_API_URL,
      apiKey: process.env.PROS_LINEAR_API_KEY,
      limit: 100,
    });
    const issues = await source.fetchIssues();
    const tickets: LinearTicket[] = issues.map(toTicket);
    return NextResponse.json({ ok: true, tickets: filterLinearTickets(tickets, { search, status, label, team }) });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        unavailable: true,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 200 },
    );
  }
}

function toTicket(issue: LinearIssueFixture): LinearTicket {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    url: issue.url,
    updatedAt: issue.updatedAt,
    labels: issue.labels ?? [],
    team: issue.team,
    teamKey: issue.teamKey,
    status: issue.status,
    priority: issue.priority,
    assignee: issue.assignee,
  };
}
