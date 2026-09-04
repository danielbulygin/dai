/**
 * Can a customer-scoped read reach another customer's account?
 *
 * Every case below is a READ, and every one but the control is expected to be
 * REFUSED. The pair is the real hole rather than a synthetic one: the agency
 * token that reads Teethlovers also reads Laori, so if the boundary were the
 * token alone, these would succeed when they must not.
 *
 * Read-only. Nothing here writes.
 */
import { metaGraphGet } from "../src/agents/tools/investigation-tools.js";
import { getTokenForClient } from "../src/integrations/meta-token.js";

const TL = "TL";
const TL_ACCT = "act_210156414037422";
const LAORI_ACCT = "act_317049334";
const LAORI_CAMPAIGN = "52524090473953";

let failures = 0;

function say(ok: boolean, label: string, detail = ""): void {
	if (!ok) failures += 1;
	console.log(
		`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
	);
}

function refused(raw: string): boolean {
	try {
		const parsed = JSON.parse(raw) as { error?: string };
		return typeof parsed.error === "string" && parsed.error.length > 0;
	} catch {
		return false;
	}
}

function firstLine(raw: string, n = 110): string {
	try {
		const parsed = JSON.parse(raw) as { error?: string };
		if (parsed.error) return parsed.error.slice(0, n);
	} catch {
		/* not an error shape — fall through to the raw text */
	}
	return raw.slice(0, n).replace(/\s+/g, " ");
}

async function main(): Promise<void> {
	console.log(
		"\ntenancy probe — can a customer-scoped read reach another account?\n",
	);

	console.log("control — the client's own account");
	const own = await metaGraphGet({
		clientCode: TL,
		path: `${TL_ACCT}/campaigns`,
		params: { limit: "1" },
	});
	say(!refused(own), "TL can read its OWN account", firstLine(own, 70));

	console.log("\nanother tenant, by account name");
	const byName = await metaGraphGet({
		clientCode: TL,
		path: `${LAORI_ACCT}/campaigns`,
		params: { limit: "1" },
	});
	say(refused(byName), "TL is refused Laori's account", firstLine(byName));

	console.log("\nanother tenant, by bare object id (not account-scoped)");
	const byId = await metaGraphGet({
		clientCode: TL,
		path: LAORI_CAMPAIGN,
		params: { fields: "name" },
	});
	say(refused(byId), "TL is refused Laori's campaign by id", firstLine(byId));

	console.log(
		"\nagency-wide paths — these would read the AGENCY's own surface",
	);
	for (const path of ["me/adaccounts", "search", "debug_token"]) {
		const res = await metaGraphGet({ clientCode: TL, path, params: {} });
		say(refused(res), `TL is refused "${path}"`, firstLine(res, 80));
	}

	console.log(
		"\nno usable connection — must NOT fall back to the agency token",
	);
	const stranger = await getTokenForClient({
		userId: "probe-user-with-no-connection",
	});
	say(
		stranger === null,
		"a self-serve identity with no connection gets NO token",
		stranger === null
			? "returned null"
			: `returned a token from source "${stranger.source}"`,
	);

	const unknown = await metaGraphGet({
		clientCode: "NOPE_NOT_A_CLIENT",
		path: "me/adaccounts",
		params: {},
	});
	say(
		refused(unknown),
		"an unknown client code reads nothing",
		firstLine(unknown, 80),
	);

	console.log(
		`\n${failures === 0 ? "boundary holds." : `${failures} check(s) FAILED — the boundary does not hold.`}\n`,
	);
	process.exitCode = failures === 0 ? 0 : 1;
}

void main();
