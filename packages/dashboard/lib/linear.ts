export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url?: string;
  updatedAt: string;
  labels: string[];
  team?: string;
  teamKey?: string;
  status?: string;
  priority?: string;
  assignee?: string;
}

export function filterLinearTickets(
  tickets: LinearTicket[],
  filters: { search?: string; status?: string; label?: string; team?: string },
): LinearTicket[] {
  const search = filters.search?.trim().toLowerCase() ?? "";
  const status = filters.status?.trim().toLowerCase() ?? "";
  const label = filters.label?.trim().toLowerCase() ?? "";
  const team = filters.team?.trim().toLowerCase() ?? "";

  return tickets.filter((ticket) => {
    const ticketTeam = `${ticket.teamKey ?? ""} ${ticket.team ?? ""}`.trim().toLowerCase();
    if (team && ticketTeam && !ticketTeam.split(/\s+/).includes(team) && !ticketTeam.includes(team)) return false;
    const haystack = [ticket.identifier, ticket.title, ticket.description, ticket.assignee, ticket.team]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (search && !haystack.includes(search)) return false;
    if (status && (ticket.status ?? "").toLowerCase() !== status) return false;
    if (label && !ticket.labels.some((item) => item.toLowerCase() === label)) return false;
    return true;
  });
}
