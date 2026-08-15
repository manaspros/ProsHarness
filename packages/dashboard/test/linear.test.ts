import test from "node:test";
import assert from "node:assert/strict";

import { filterLinearTickets, type LinearTicket } from "../lib/linear.js";

const tickets: LinearTicket[] = [
  {
    id: "1",
    identifier: "ENG-101",
    title: "Fix the prompt composer",
    description: "The composer loses context.",
    updatedAt: "2026-08-15T00:00:00.000Z",
    labels: ["frontend"],
    team: "Engineering",
    teamKey: "ENG",
    status: "In Progress",
  },
  {
    id: "2",
    identifier: "DES-9",
    title: "Refresh the brand colors",
    description: "Update the visual system.",
    updatedAt: "2026-08-14T00:00:00.000Z",
    labels: ["design"],
    team: "Design",
    teamKey: "DES",
    status: "Todo",
  },
];

test("filterLinearTickets combines search, status, label, and team filters", () => {
  assert.deepEqual(
    filterLinearTickets(tickets, { team: "ENG", search: "composer", status: "in progress", label: "frontend" }).map((ticket) => ticket.identifier),
    ["ENG-101"],
  );
  assert.deepEqual(filterLinearTickets(tickets, { team: "ENG" }).map((ticket) => ticket.identifier), ["ENG-101"]);
});
