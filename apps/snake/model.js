'use strict';
/**
 * Snake's rules, without drawing or the car (tested in tests/snake.test.js).
 *
 *   const g = new Game({ cols: 34, rows: 15, walls: 'wrap' });
 *   g.turn('N') / g.turnBy(1)   // queue a turn (absolute, or +1 right / -1 left of the way it goes)
 *   g.step()                    // one move: 'move', 'eat', 'dead' or 'won'
 *
 * The snake is a list of cells, head first; `prev` is the list before the last step (main.js slides
 * each segment from its prev cell to its cell between two steps). Up to two turns wait in a queue, so
 * a quick "up, left" both land; a turn back into the snake's own neck is ignored.
 */
const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const ORDER = ['N', 'E', 'S', 'W'];                   // clockwise: +1 is a right turn
const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
const QUEUE = 2;

/** step time per speed setting (ms); it shortens a little with every food, down to FASTEST of it */
const SPEEDS = { slow: 180, normal: 130, fast: 90 };
const SPEEDUP_MS = 3;
const FASTEST = 0.6;

class Game {
    constructor(o) {
        o = o || {};
        this.cols = o.cols || 34;
        this.rows = o.rows || 15;
        this.walls = o.walls === 'solid' ? 'solid' : 'wrap';
        this.rng = o.rng || Math.random;
        this.reset();
    }

    reset() {
        const y = Math.floor(this.rows / 2), x = Math.floor(this.cols / 3);
        this.snake = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }];
        this.prev = this.snake.map((c) => ({ x: c.x, y: c.y }));
        this.dir = 'E';
        this.queue = [];
        this.score = 0;
        this.over = false;
        this.won = false;
        this.food = this._place();
    }

    /** queue an absolute turn; false when it changes nothing or would go back into the neck */
    turn(d) {
        if (!DIRS[d] || this.over) return false;
        const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
        if (d === last || d === OPPOSITE[last] || this.queue.length >= QUEUE) return false;
        this.queue.push(d);
        return true;
    }

    /** queue a turn relative to where the snake will be heading: +1 right, -1 left */
    turnBy(n) {
        const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
        return this.turn(ORDER[(ORDER.indexOf(last) + (n > 0 ? 1 : 3)) % 4]);
    }

    step() {
        if (this.over) return this.won ? 'won' : 'dead';
        if (this.queue.length) this.dir = this.queue.shift();
        const [dx, dy] = DIRS[this.dir], h = this.snake[0];
        let x = h.x + dx, y = h.y + dy;
        if (this.walls === 'wrap') { x = (x + this.cols) % this.cols; y = (y + this.rows) % this.rows; } else if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return this._die();
        const eat = this.food && x === this.food.x && y === this.food.y;
        // the tail moves out of the way this step, unless the snake grows
        const body = eat ? this.snake : this.snake.slice(0, -1);
        if (body.some((c) => c.x === x && c.y === y)) return this._die();
        this.prev = this.snake.map((c) => ({ x: c.x, y: c.y }));
        this.snake = [{ x, y }].concat(body);
        if (!eat) return 'move';
        this.score++;
        this.food = this._place();
        if (!this.food) { this.over = true; this.won = true; return 'won'; }
        return 'eat';
    }

    /** ms per step for a speed setting, after this many foods */
    static stepMs(speed, score) {
        const base = SPEEDS[speed] || SPEEDS.normal;
        return Math.max(Math.round(base * FASTEST), base - SPEEDUP_MS * (score || 0));
    }

    _die() {
        this.over = true;
        this.prev = this.snake.map((c) => ({ x: c.x, y: c.y }));
        return 'dead';
    }

    /** a free cell for the food, or null when the snake fills the board */
    _place() {
        const taken = new Set(this.snake.map((c) => c.y * this.cols + c.x));
        const free = this.cols * this.rows - taken.size;
        if (free <= 0) return null;
        let k = Math.floor(this.rng() * free);
        for (let i = 0; i < this.cols * this.rows; i++) {
            if (taken.has(i)) continue;
            if (k-- === 0) return { x: i % this.cols, y: Math.floor(i / this.cols) };
        }
        return null;
    }
}

/** best scores, one per speed and walls ("normal/wrap"), in the app's data folder */
function loadBest(file, log) {
    try { const b = JSON.parse(require('fs').readFileSync(file, 'utf8')); return b && typeof b === 'object' ? b : {}; } catch (e) {
        if (e.code !== 'ENOENT' && log) log.warn('snake: best scores not read: ' + e.message);
        return {};
    }
}
function saveBest(file, best) {
    const fs = require('fs');
    fs.writeFileSync(file + '.tmp', JSON.stringify(best));
    fs.renameSync(file + '.tmp', file);
}

module.exports = { Game, DIRS, ORDER, SPEEDS, loadBest, saveBest };
