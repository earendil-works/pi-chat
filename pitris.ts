import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";

type Cell = 0 | 1;
type Point = [number, number];

type PieceDef = {
	name: string;
	rotations: Point[][];
};

type ActivePiece = {
	def: PieceDef;
	rotation: number;
	x: number;
	y: number;
};

type GameState = {
	board: Cell[][];
	active?: ActivePiece;
	score: number;
	lines: number;
	gameOver: boolean;
};

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 16;
const TICK_MS = 320;
const CELL_WIDTH = 2;

function normalize(points: Point[]): Point[] {
	const minX = Math.min(...points.map(([x]) => x));
	const minY = Math.min(...points.map(([, y]) => y));
	return points.map(([x, y]) => [x - minX, y - minY] as Point).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function rotate90(points: Point[]): Point[] {
	return normalize(points.map(([x, y]) => [3 - y, x] as Point));
}

function uniqueRotations(points: Point[]): Point[][] {
	const out: Point[][] = [];
	const seen = new Set<string>();
	let current = normalize(points);
	for (let i = 0; i < 4; i++) {
		const key = JSON.stringify(current);
		if (!seen.has(key)) {
			seen.add(key);
			out.push(current);
		}
		current = rotate90(current);
	}
	return out;
}

const PI_LOGO_SHAPE: Point[] = [
	[0, 0],
	[1, 0],
	[2, 0],
	[0, 1],
	[2, 1],
	[0, 2],
	[1, 2],
	[3, 2],
	[0, 3],
	[3, 3],
];

const PI_PIECE: PieceDef = {
	name: "π",
	rotations: uniqueRotations(PI_LOGO_SHAPE),
};

function makeBoard(): Cell[][] {
	return Array.from({ length: BOARD_HEIGHT }, () => Array.from({ length: BOARD_WIDTH }, () => 0 as Cell));
}

function cloneBoard(board: Cell[][]): Cell[][] {
	return board.map((row) => [...row] as Cell[]);
}

function getCells(piece: ActivePiece): Point[] {
	return piece.def.rotations[piece.rotation].map(([x, y]) => [piece.x + x, piece.y + y]);
}

function collides(board: Cell[][], piece: ActivePiece): boolean {
	return getCells(piece).some(([x, y]) => {
		if (x < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return true;
		if (y < 0) return false;
		return board[y][x] === 1;
	});
}

function stamp(board: Cell[][], piece: ActivePiece): void {
	for (const [x, y] of getCells(piece)) {
		if (x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT) {
			board[y][x] = 1;
		}
	}
}

function clearLines(board: Cell[][]): number {
	let cleared = 0;
	for (let y = BOARD_HEIGHT - 1; y >= 0; y--) {
		if (board[y].every((cell) => cell === 1)) {
			board.splice(y, 1);
			board.unshift(Array.from({ length: BOARD_WIDTH }, () => 0 as Cell));
			cleared += 1;
			y += 1;
		}
	}
	return cleared;
}

function createInitialState(): GameState {
	return {
		board: makeBoard(),
		active: undefined,
		score: 0,
		lines: 0,
		gameOver: false,
	};
}

function spawnPiece(board: Cell[][]): ActivePiece | undefined {
	const piece: ActivePiece = {
		def: PI_PIECE,
		rotation: 0,
		x: Math.floor((BOARD_WIDTH - 4) / 2),
		y: -1,
	};
	return collides(board, piece) ? undefined : piece;
}

function tryMove(board: Cell[][], piece: ActivePiece, dx: number, dy: number): ActivePiece | undefined {
	const moved = { ...piece, x: piece.x + dx, y: piece.y + dy };
	return collides(board, moved) ? undefined : moved;
}

function tryRotate(board: Cell[][], piece: ActivePiece): ActivePiece | undefined {
	const rotated = { ...piece, rotation: (piece.rotation + 1) % piece.def.rotations.length };
	const kicks: Array<[number, number]> = [
		[0, 0],
		[-1, 0],
		[1, 0],
		[-2, 0],
		[2, 0],
		[0, -1],
	];

	for (const [dx, dy] of kicks) {
		const kicked = { ...rotated, x: rotated.x + dx, y: rotated.y + dy };
		if (!collides(board, kicked)) return kicked;
	}
	return undefined;
}

class PitrisComponent {
	private state: GameState = createInitialState();
	private interval: ReturnType<typeof setInterval> | null = null;
	private tui: { requestRender: () => void };
	private close: () => void;
	private cachedWidth = 0;
	private cachedVersion = -1;
	private cachedLines: string[] = [];
	private version = 0;

	constructor(tui: { requestRender: () => void }, close: () => void) {
		this.tui = tui;
		this.close = close;
		this.state.active = spawnPiece(this.state.board);
		if (!this.state.active) this.state.gameOver = true;
		this.interval = setInterval(() => {
			this.tick();
			this.version += 1;
			this.tui.requestRender();
		}, TICK_MS);
	}

	private lockPiece(): void {
		if (!this.state.active) return;
		stamp(this.state.board, this.state.active);
		const cleared = clearLines(this.state.board);
		this.state.lines += cleared;
		this.state.score += 10 + cleared * 100;
		this.state.active = spawnPiece(this.state.board);
		if (!this.state.active) this.state.gameOver = true;
	}

	private tick(): void {
		if (this.state.gameOver) return;
		if (!this.state.active) {
			this.state.active = spawnPiece(this.state.board);
			if (!this.state.active) this.state.gameOver = true;
			return;
		}
		const fallen = tryMove(this.state.board, this.state.active, 0, 1);
		if (fallen) this.state.active = fallen;
		else this.lockPiece();
	}

	private softDrop(): void {
		if (this.state.gameOver || !this.state.active) return;
		const fallen = tryMove(this.state.board, this.state.active, 0, 1);
		if (fallen) {
			this.state.active = fallen;
			this.state.score += 1;
		} else {
			this.lockPiece();
		}
		this.version += 1;
		this.tui.requestRender();
	}

	private reset(): void {
		this.state = createInitialState();
		this.state.active = spawnPiece(this.state.board);
		if (!this.state.active) this.state.gameOver = true;
		this.version += 1;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.dispose();
			this.close();
			return;
		}

		if (this.state.gameOver) {
			if (data === "r" || data === "R" || matchesKey(data, "enter") || matchesKey(data, "space")) {
				this.reset();
			}
			return;
		}

		const active = this.state.active;
		if (!active) return;

		if (matchesKey(data, "left") || data === "j" || data === "J") {
			const moved = tryMove(this.state.board, active, -1, 0);
			if (moved) this.state.active = moved;
		} else if (matchesKey(data, "right") || data === "l" || data === "L") {
			const moved = tryMove(this.state.board, active, 1, 0);
			if (moved) this.state.active = moved;
		} else if (matchesKey(data, "down") || data === "k" || data === "K") {
			this.softDrop();
			return;
		} else if (matchesKey(data, "up") || data === "i" || data === "I" || matchesKey(data, "space")) {
			const rotated = tryRotate(this.state.board, active);
			if (rotated) this.state.active = rotated;
		}

		this.version += 1;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const board = cloneBoard(this.state.board);
		if (this.state.active) stamp(board, this.state.active);

		const lines: string[] = [];
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const accent = (s: string) => `\x1b[35m${s}\x1b[39m`;
		const warning = (s: string) => `\x1b[33m${s}\x1b[39m`;
		const error = (s: string) => `\x1b[31m${s}\x1b[39m`;

		const boxWidth = BOARD_WIDTH * CELL_WIDTH;
		const padLine = (line: string) => line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const framed = (content: string) => {
			const padding = Math.max(0, boxWidth - visibleWidth(content));
			return dim(" │") + content + " ".repeat(padding) + dim("│");
		};

		lines.push(padLine(dim(` ╭${"─".repeat(boxWidth)}╮`)));
		lines.push(
			padLine(
				framed(
					`${accent(bold("Pitris"))} │ score ${warning(String(this.state.score))} │ lines ${warning(String(this.state.lines))}`,
				),
			),
		);
		lines.push(padLine(dim(` ├${"─".repeat(boxWidth)}┤`)));

		for (let y = 0; y < BOARD_HEIGHT; y++) {
			let row = "";
			for (let x = 0; x < BOARD_WIDTH; x++) {
				row += board[y][x] ? accent("ππ") : "  ";
			}
			lines.push(padLine(dim(" │") + row + dim("│")));
		}

		lines.push(padLine(dim(` ├${"─".repeat(boxWidth)}┤`)));
		if (this.state.gameOver) {
			lines.push(padLine(framed(`${error(bold("game over"))} │ ${bold("R")} restart │ ${bold("Q")} quit`)));
		} else {
			lines.push(padLine(framed(`←→ / J L move │ ↑/I/space rotate │ ↓/K soft drop`)));
		}
		lines.push(padLine(dim(` ╰${"─".repeat(boxWidth)}╯`)));

		this.cachedWidth = width;
		this.cachedVersion = this.version;
		this.cachedLines = lines;
		return lines;
	}

	dispose(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
	}
}

export default function pitris(pi: ExtensionAPI) {
	pi.registerCommand("pitris", {
		description: "Play Pitris with the pi.dev logo block",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Pitris requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom((tui, _theme, _kb, done) => new PitrisComponent(tui, () => done(undefined)));
		},
	});
}
