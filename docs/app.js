(function () {
    "use strict";

    const BLOCK_SIZE = 4;
    const BLOCK_PIXELS = 16;
    const D1 = 36;
    const D2 = 20;
    const META_REPEAT = 6;
    const META_BYTES = 8;
    const META_BITS = META_BYTES * 8;
    const PREVIEW_MAX = 640;
    const POWER_ITERATIONS = 24;
    const EPSILON = 1e-8;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const DCT = createDctMatrix(BLOCK_SIZE);
    const DCT_T = transpose(DCT);

    function createZeroMatrix(rows, cols) {
        const matrix = new Array(rows);
        for (let row = 0; row < rows; row += 1) {
            matrix[row] = new Array(cols).fill(0);
        }
        return matrix;
    }

    function cloneMatrix(matrix) {
        return matrix.map((row) => row.slice());
    }

    function transpose(matrix) {
        const out = createZeroMatrix(matrix[0].length, matrix.length);
        for (let row = 0; row < matrix.length; row += 1) {
            for (let col = 0; col < matrix[0].length; col += 1) {
                out[col][row] = matrix[row][col];
            }
        }
        return out;
    }

    function multiplyMatrices(a, b) {
        const out = createZeroMatrix(a.length, b[0].length);
        for (let row = 0; row < a.length; row += 1) {
            for (let col = 0; col < b[0].length; col += 1) {
                let sum = 0;
                for (let i = 0; i < b.length; i += 1) {
                    sum += a[row][i] * b[i][col];
                }
                out[row][col] = sum;
            }
        }
        return out;
    }

    function multiplyMatrixVector(matrix, vector) {
        const out = new Array(matrix.length).fill(0);
        for (let row = 0; row < matrix.length; row += 1) {
            let sum = 0;
            for (let col = 0; col < vector.length; col += 1) {
                sum += matrix[row][col] * vector[col];
            }
            out[row] = sum;
        }
        return out;
    }

    function dot(a, b) {
        let sum = 0;
        for (let i = 0; i < a.length; i += 1) {
            sum += a[i] * b[i];
        }
        return sum;
    }

    function norm(vector) {
        return Math.sqrt(dot(vector, vector));
    }

    function normalize(vector) {
        const value = norm(vector);
        if (value < EPSILON) {
            return null;
        }
        return vector.map((entry) => entry / value);
    }

    function flattenMatrix(matrix) {
        const out = new Array(matrix.length * matrix[0].length);
        let cursor = 0;
        for (let row = 0; row < matrix.length; row += 1) {
            for (let col = 0; col < matrix[0].length; col += 1) {
                out[cursor] = matrix[row][col];
                cursor += 1;
            }
        }
        return out;
    }

    function reshapeToMatrix(values, rows, cols) {
        const out = createZeroMatrix(rows, cols);
        let cursor = 0;
        for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < cols; col += 1) {
                out[row][col] = values[cursor];
                cursor += 1;
            }
        }
        return out;
    }

    function shuffleFlat(values, indices) {
        const out = new Array(indices.length);
        for (let i = 0; i < indices.length; i += 1) {
            out[i] = values[indices[i]];
        }
        return out;
    }

    function unshuffleFlat(values, indices) {
        const out = new Array(indices.length);
        for (let i = 0; i < indices.length; i += 1) {
            out[indices[i]] = values[i];
        }
        return out;
    }

    function addScaledOuter(matrix, u, v, scale) {
        const out = cloneMatrix(matrix);
        for (let row = 0; row < out.length; row += 1) {
            for (let col = 0; col < out[0].length; col += 1) {
                out[row][col] += u[row] * v[col] * scale;
            }
        }
        return out;
    }

    function createDctMatrix(size) {
        const matrix = createZeroMatrix(size, size);
        for (let k = 0; k < size; k += 1) {
            const alpha = k === 0 ? Math.sqrt(1 / size) : Math.sqrt(2 / size);
            for (let n = 0; n < size; n += 1) {
                matrix[k][n] = alpha * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * size));
            }
        }
        return matrix;
    }

    function dct2(block) {
        return multiplyMatrices(multiplyMatrices(DCT, block), DCT_T);
    }

    function idct2(block) {
        return multiplyMatrices(multiplyMatrices(DCT_T, block), DCT);
    }

    function hashPassword(input) {
        let hash = 2166136261 >>> 0;
        const value = String(input || "");
        for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function makeSeeds(password) {
        const base = hashPassword(password || "") || 1;
        return {
            passwordImg: base,
            passwordWm: (base ^ 0x9e3779b9) >>> 0 || 1
        };
    }

    function mulberry32(seed) {
        let state = seed >>> 0;
        return function next() {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function createPermutation(length, seed) {
        const items = new Uint32Array(length);
        for (let i = 0; i < length; i += 1) {
            items[i] = i;
        }
        const random = mulberry32(seed || 1);
        for (let i = length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            const value = items[i];
            items[i] = items[j];
            items[j] = value;
        }
        return items;
    }

    function createBlockShuffle(blockCount, seed) {
        const random = mulberry32(seed || 1);
        const out = new Array(blockCount);
        for (let i = 0; i < blockCount; i += 1) {
            const pairs = new Array(BLOCK_PIXELS);
            for (let j = 0; j < BLOCK_PIXELS; j += 1) {
                pairs[j] = { index: j, value: random() };
            }
            pairs.sort((a, b) => a.value - b.value);
            out[i] = pairs.map((item) => item.index);
        }
        return out;
    }

    function bytesToBits(bytes) {
        const bits = new Uint8Array(bytes.length * 8);
        for (let i = 0; i < bytes.length; i += 1) {
            for (let bit = 0; bit < 8; bit += 1) {
                bits[i * 8 + bit] = (bytes[i] >> (7 - bit)) & 1;
            }
        }
        return bits;
    }

    function bitsToBytes(bits) {
        const bytes = new Uint8Array(Math.ceil(bits.length / 8));
        for (let i = 0; i < bits.length; i += 1) {
            const byteIndex = Math.floor(i / 8);
            bytes[byteIndex] = ((bytes[byteIndex] << 1) | bits[i]) & 255;
        }
        const remaining = bits.length % 8;
        if (remaining !== 0) {
            bytes[bytes.length - 1] = (bytes[bytes.length - 1] << (8 - remaining)) & 255;
        }
        return bytes;
    }

    function checksum(bytes) {
        let hash = 2166136261 >>> 0;
        for (let i = 0; i < bytes.length; i += 1) {
            hash ^= bytes[i];
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function numberToBytes(value) {
        return new Uint8Array([
            (value >>> 24) & 255,
            (value >>> 16) & 255,
            (value >>> 8) & 255,
            value & 255
        ]);
    }

    function bytesToNumber(bytes, offset) {
        return (
            ((bytes[offset] << 24) >>> 0) +
            ((bytes[offset + 1] << 16) >>> 0) +
            ((bytes[offset + 2] << 8) >>> 0) +
            (bytes[offset + 3] >>> 0)
        ) >>> 0;
    }

    function composeMeta(messageBytes) {
        const meta = new Uint8Array(META_BYTES);
        meta.set(numberToBytes(messageBytes.length), 0);
        meta.set(numberToBytes(checksum(messageBytes)), 4);
        return bytesToBits(meta);
    }

    function parseMeta(bits) {
        const meta = bitsToBytes(bits);
        return {
            length: bytesToNumber(meta, 0),
            checksum: bytesToNumber(meta, 4)
        };
    }

    function shuffleWatermarkBits(bits, seed) {
        const order = createPermutation(bits.length, seed);
        const out = new Uint8Array(bits.length);
        for (let i = 0; i < bits.length; i += 1) {
            out[i] = bits[order[i]];
        }
        return out;
    }

    function unshuffleWatermarkBits(bits, seed) {
        const order = createPermutation(bits.length, seed);
        const out = new Uint8Array(bits.length);
        for (let i = 0; i < bits.length; i += 1) {
            out[order[i]] = bits[i];
        }
        return out;
    }

    function powerIteration(matrix) {
        let vector = normalize([1, 0.7, 0.3, 0.1]);
        for (let i = 0; i < POWER_ITERATIONS; i += 1) {
            const next = multiplyMatrixVector(matrix, vector);
            const normalized = normalize(next);
            if (!normalized) {
                return null;
            }
            vector = normalized;
        }
        const value = dot(vector, multiplyMatrixVector(matrix, vector));
        return { value: Math.max(0, value), vector };
    }

    function subtractRankOne(matrix, u, v, sigma) {
        const out = cloneMatrix(matrix);
        for (let row = 0; row < out.length; row += 1) {
            for (let col = 0; col < out[0].length; col += 1) {
                out[row][col] -= u[row] * v[col] * sigma;
            }
        }
        return out;
    }

    function approximateTopTwoSingular(matrix) {
        const ata = multiplyMatrices(transpose(matrix), matrix);
        const first = powerIteration(ata);
        if (!first || first.value < EPSILON) {
            return [
                { sigma: 0, u: [1, 0, 0, 0], v: [1, 0, 0, 0] },
                { sigma: 0, u: [0, 1, 0, 0], v: [0, 1, 0, 0] }
            ];
        }
        const sigma1 = Math.sqrt(first.value);
        const u1 = normalize(multiplyMatrixVector(matrix, first.vector)) || [1, 0, 0, 0];
        const residual = subtractRankOne(matrix, u1, first.vector, sigma1);
        const second = powerIteration(multiplyMatrices(transpose(residual), residual));
        if (!second || second.value < EPSILON) {
            return [
                { sigma: sigma1, u: u1, v: first.vector },
                { sigma: 0, u: [0, 1, 0, 0], v: [0, 1, 0, 0] }
            ];
        }
        const sigma2 = Math.sqrt(second.value);
        const u2 = normalize(multiplyMatrixVector(residual, second.vector)) || [0, 1, 0, 0];
        return [
            { sigma: sigma1, u: u1, v: first.vector },
            { sigma: sigma2, u: u2, v: second.vector }
        ];
    }

    function quantizeSingular(value, step, watermarkBit) {
        return (Math.floor(value / step) + 0.25 + 0.5 * watermarkBit) * step;
    }

    function rgbToYuv(r, g, b) {
        return [
            0.299 * r + 0.587 * g + 0.114 * b,
            -0.14713 * r - 0.28886 * g + 0.436 * b,
            0.615 * r - 0.51499 * g - 0.10001 * b
        ];
    }

    function yuvToRgb(y, u, v) {
        return [
            y + 1.13983 * v,
            y - 0.39465 * u - 0.5806 * v,
            y + 2.03211 * u
        ];
    }

    function clamp255(value) {
        return Math.max(0, Math.min(255, Math.round(value)));
    }

    function splitChannels(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const evenWidth = width + (width % 2);
        const evenHeight = height + (height % 2);
        const size = evenWidth * evenHeight;
        const channels = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];
        const alpha = new Uint8ClampedArray(width * height);

        for (let row = 0; row < height; row += 1) {
            for (let col = 0; col < width; col += 1) {
                const src = (row * width + col) * 4;
                const dst = row * evenWidth + col;
                const yuv = rgbToYuv(
                    imageData.data[src],
                    imageData.data[src + 1],
                    imageData.data[src + 2]
                );
                channels[0][dst] = yuv[0];
                channels[1][dst] = yuv[1];
                channels[2][dst] = yuv[2];
                alpha[row * width + col] = imageData.data[src + 3];
            }
        }

        return { width, height, evenWidth, evenHeight, channels, alpha };
    }

    function mergeChannels(state) {
        const out = new Uint8ClampedArray(state.width * state.height * 4);
        for (let row = 0; row < state.height; row += 1) {
            for (let col = 0; col < state.width; col += 1) {
                const src = row * state.evenWidth + col;
                const dst = (row * state.width + col) * 4;
                const rgb = yuvToRgb(
                    state.channels[0][src],
                    state.channels[1][src],
                    state.channels[2][src]
                );
                out[dst] = clamp255(rgb[0]);
                out[dst + 1] = clamp255(rgb[1]);
                out[dst + 2] = clamp255(rgb[2]);
                out[dst + 3] = state.alpha[row * state.width + col];
            }
        }
        return new ImageData(out, state.width, state.height);
    }

    function dwt2(channel, width, height) {
        const halfWidth = width / 2;
        const halfHeight = height / 2;
        const ca = new Float64Array(halfWidth * halfHeight);
        const ch = new Float64Array(halfWidth * halfHeight);
        const cv = new Float64Array(halfWidth * halfHeight);
        const cd = new Float64Array(halfWidth * halfHeight);

        for (let row = 0; row < halfHeight; row += 1) {
            for (let col = 0; col < halfWidth; col += 1) {
                const r = row * 2;
                const c = col * 2;
                const a = channel[r * width + c];
                const b = channel[r * width + c + 1];
                const d = channel[(r + 1) * width + c];
                const e = channel[(r + 1) * width + c + 1];
                const index = row * halfWidth + col;
                ca[index] = (a + b + d + e) / 2;
                ch[index] = (a - b + d - e) / 2;
                cv[index] = (a + b - d - e) / 2;
                cd[index] = (a - b - d + e) / 2;
            }
        }
        return { ca, ch, cv, cd, width: halfWidth, height: halfHeight };
    }

    function idwt2(transformed) {
        const width = transformed.width * 2;
        const out = new Float64Array(width * transformed.height * 2);
        for (let row = 0; row < transformed.height; row += 1) {
            for (let col = 0; col < transformed.width; col += 1) {
                const index = row * transformed.width + col;
                const ll = transformed.ca[index];
                const lh = transformed.ch[index];
                const hl = transformed.cv[index];
                const hh = transformed.cd[index];
                const r = row * 2;
                const c = col * 2;
                out[r * width + c] = (ll + lh + hl + hh) / 2;
                out[r * width + c + 1] = (ll - lh + hl - hh) / 2;
                out[(r + 1) * width + c] = (ll + lh - hl - hh) / 2;
                out[(r + 1) * width + c + 1] = (ll - lh - hl + hh) / 2;
            }
        }
        return out;
    }

    function getImageShape(imageLike) {
        const evenWidth = imageLike.width + (imageLike.width % 2);
        const evenHeight = imageLike.height + (imageLike.height % 2);
        return {
            evenWidth,
            evenHeight,
            caWidth: evenWidth / 2,
            caHeight: evenHeight / 2,
            blockCols: Math.floor(evenWidth / 2 / BLOCK_SIZE),
            blockRows: Math.floor(evenHeight / 2 / BLOCK_SIZE)
        };
    }

    function getBlockCount(imageLike) {
        const shape = getImageShape(imageLike);
        return shape.blockRows * shape.blockCols;
    }

    function getCapacity(imageLike) {
        const usableBlocks = getBlockCount(imageLike) - META_BITS * META_REPEAT;
        return usableBlocks > 0 ? Math.floor(usableBlocks / 8) : 0;
    }

    function getBlock(matrix, width, blockRow, blockCol) {
        const out = createZeroMatrix(BLOCK_SIZE, BLOCK_SIZE);
        for (let row = 0; row < BLOCK_SIZE; row += 1) {
            for (let col = 0; col < BLOCK_SIZE; col += 1) {
                out[row][col] = matrix[(blockRow * BLOCK_SIZE + row) * width + blockCol * BLOCK_SIZE + col];
            }
        }
        return out;
    }

    function setBlock(matrix, width, blockRow, blockCol, block) {
        for (let row = 0; row < BLOCK_SIZE; row += 1) {
            for (let col = 0; col < BLOCK_SIZE; col += 1) {
                matrix[(blockRow * BLOCK_SIZE + row) * width + blockCol * BLOCK_SIZE + col] = block[row][col];
            }
        }
    }

    function extractBitScore(block, shuffle) {
        const dctBlock = dct2(block);
        const shuffled = reshapeToMatrix(shuffleFlat(flattenMatrix(dctBlock), shuffle), BLOCK_SIZE, BLOCK_SIZE);
        const triplets = approximateTopTwoSingular(shuffled);
        let score = (triplets[0].sigma % D1 > D1 / 2) ? 1 : 0;
        if (D2 > 0) {
            score = (score * 3 + ((triplets[1].sigma % D2 > D2 / 2) ? 1 : 0)) / 4;
        }
        return score;
    }

    async function maybeYield(index, total, onProgress, label) {
        if (!onProgress || index % 120 !== 0) {
            return;
        }
        onProgress({
            label,
            current: index,
            total
        });
        await new Promise((resolve) => {
            if (typeof requestAnimationFrame === "function") {
                requestAnimationFrame(() => resolve());
            } else {
                setTimeout(resolve, 0);
            }
        });
    }

    async function transformImageWithWatermark(imageData, message, password, onProgress) {
        const messageBytes = encoder.encode(message || "");
        const messageBits = bytesToBits(messageBytes);
        const metaBits = composeMeta(messageBytes);
        const seeds = makeSeeds(password);
        const state = splitChannels(imageData);
        const shape = getImageShape(imageData);
        const blockCount = shape.blockRows * shape.blockCols;
        const metaBlockCount = META_BITS * META_REPEAT;

        if (!messageBytes.length) {
            throw new Error("请输入要嵌入的文字水印。");
        }
        if (blockCount <= metaBlockCount) {
            throw new Error("图片过小，请换更大的图片。");
        }
        if (messageBits.length >= blockCount - metaBlockCount) {
            throw new Error(`图片容量不足，最多可嵌入约 ${getCapacity(imageData)} 字节。`);
        }

        const transformed = state.channels.map((channel) => dwt2(channel, state.evenWidth, state.evenHeight));
        const blockShuffle = createBlockShuffle(blockCount, seeds.passwordImg);
        const shuffledMessageBits = shuffleWatermarkBits(messageBits, seeds.passwordWm);
        const total = blockCount * transformed.length;
        let progress = 0;

        for (let channelIndex = 0; channelIndex < transformed.length; channelIndex += 1) {
            const channel = transformed[channelIndex];
            for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
                const blockRow = Math.floor(blockIndex / shape.blockCols);
                const blockCol = blockIndex % shape.blockCols;
                const block = getBlock(channel.ca, channel.width, blockRow, blockCol);
                const dctBlock = dct2(block);
                const shuffle = blockShuffle[blockIndex];
                const shuffled = reshapeToMatrix(shuffleFlat(flattenMatrix(dctBlock), shuffle), BLOCK_SIZE, BLOCK_SIZE);
                const triplets = approximateTopTwoSingular(shuffled);
                const bit = blockIndex < metaBlockCount
                    ? metaBits[Math.floor(blockIndex / META_REPEAT)]
                    : shuffledMessageBits[(blockIndex - metaBlockCount) % shuffledMessageBits.length];

                let modified = shuffled;
                modified = addScaledOuter(modified, triplets[0].u, triplets[0].v, quantizeSingular(triplets[0].sigma, D1, bit) - triplets[0].sigma);
                if (D2 > 0) {
                    modified = addScaledOuter(modified, triplets[1].u, triplets[1].v, quantizeSingular(triplets[1].sigma, D2, bit) - triplets[1].sigma);
                }

                const restored = reshapeToMatrix(unshuffleFlat(flattenMatrix(modified), shuffle), BLOCK_SIZE, BLOCK_SIZE);
                setBlock(channel.ca, channel.width, blockRow, blockCol, idct2(restored));
                progress += 1;
                await maybeYield(progress, total, onProgress, "正在处理图片");
            }
        }

        for (let i = 0; i < transformed.length; i += 1) {
            state.channels[i] = idwt2(transformed[i]);
        }

        return mergeChannels(state);
    }

    async function extractWatermarkText(imageData, password, onProgress) {
        const seeds = makeSeeds(password);
        const state = splitChannels(imageData);
        const shape = getImageShape(imageData);
        const blockCount = shape.blockRows * shape.blockCols;
        const metaBlockCount = META_BITS * META_REPEAT;

        if (blockCount <= metaBlockCount) {
            throw new Error("图片过小，无法提取内容。");
        }

        const transformed = state.channels.map((channel) => dwt2(channel, state.evenWidth, state.evenHeight));
        const blockShuffle = createBlockShuffle(blockCount, seeds.passwordImg);
        const metaScores = new Float64Array(META_BITS);
        const total = blockCount * transformed.length;
        let progress = 0;

        for (let channelIndex = 0; channelIndex < transformed.length; channelIndex += 1) {
            const channel = transformed[channelIndex];
            for (let blockIndex = 0; blockIndex < metaBlockCount; blockIndex += 1) {
                const blockRow = Math.floor(blockIndex / shape.blockCols);
                const blockCol = blockIndex % shape.blockCols;
                metaScores[Math.floor(blockIndex / META_REPEAT)] += extractBitScore(
                    getBlock(channel.ca, channel.width, blockRow, blockCol),
                    blockShuffle[blockIndex]
                );
                progress += 1;
                await maybeYield(progress, total, onProgress, "正在读取图片");
            }
        }

        const metaBits = new Uint8Array(META_BITS);
        for (let i = 0; i < META_BITS; i += 1) {
            metaBits[i] = metaScores[i] / (META_REPEAT * transformed.length) >= 0.5 ? 1 : 0;
        }
        const meta = parseMeta(metaBits);
        if (meta.length <= 0 || meta.length > getCapacity(imageData)) {
            throw new Error("没有识别到有效内容，请确认图片和密码正确。");
        }

        const bodyBitLength = meta.length * 8;
        const bodyScores = new Float64Array(bodyBitLength);
        const repeats = Math.floor((blockCount - metaBlockCount) / bodyBitLength);
        if (repeats <= 0) {
            throw new Error("图片容量不足，无法恢复内容。");
        }

        for (let channelIndex = 0; channelIndex < transformed.length; channelIndex += 1) {
            const channel = transformed[channelIndex];
            for (let blockIndex = metaBlockCount; blockIndex < blockCount; blockIndex += 1) {
                const blockRow = Math.floor(blockIndex / shape.blockCols);
                const blockCol = blockIndex % shape.blockCols;
                const bitIndex = (blockIndex - metaBlockCount) % bodyBitLength;
                bodyScores[bitIndex] += extractBitScore(
                    getBlock(channel.ca, channel.width, blockRow, blockCol),
                    blockShuffle[blockIndex]
                );
                progress += 1;
                await maybeYield(progress, total, onProgress, "正在恢复内容");
            }
        }

        const shuffledBits = new Uint8Array(bodyBitLength);
        const denominator = transformed.length * Math.ceil((blockCount - metaBlockCount) / bodyBitLength);
        for (let i = 0; i < bodyBitLength; i += 1) {
            shuffledBits[i] = bodyScores[i] / denominator >= 0.5 ? 1 : 0;
        }
        const bits = unshuffleWatermarkBits(shuffledBits, seeds.passwordWm);
        const bytes = bitsToBytes(bits);
        if (checksum(bytes) !== meta.checksum) {
            throw new Error("内容校验失败，请尽量使用原始 PNG 文件。");
        }
        return decoder.decode(bytes);
    }

    function loadImageFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("读取图片失败。"));
            reader.onload = () => {
                const image = new Image();
                image.onerror = () => reject(new Error("图片格式无法解析。"));
                image.onload = () => resolve(image);
                image.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function drawPreview(canvas, source) {
        if (!source.width || !source.height) {
            return;
        }
        const ratio = Math.min(PREVIEW_MAX / source.width, PREVIEW_MAX / source.height, 1);
        canvas.width = Math.max(1, Math.round(source.width * ratio));
        canvas.height = Math.max(1, Math.round(source.height * ratio));
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }

    function setCanvasImageData(canvas, imageData) {
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.getContext("2d").putImageData(imageData, 0, 0);
    }

    function getImageData(image) {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    function setStatus(element, message, type) {
        element.textContent = message;
        element.classList.remove("error", "success");
        if (type) {
            element.classList.add(type);
        }
    }

    function setupPage() {
        const embedImageInput = document.getElementById("embed-image");
        const embedTextInput = document.getElementById("embed-text");
        const embedPasswordInput = document.getElementById("embed-password");
        const embedButton = document.getElementById("embed-button");
        const embedStatus = document.getElementById("embed-status");
        const embedStats = document.getElementById("embed-stats");
        const sourcePreview = document.getElementById("source-preview");
        const resultPreview = document.getElementById("result-preview");
        const downloadLink = document.getElementById("download-link");

        const extractImageInput = document.getElementById("extract-image");
        const extractPasswordInput = document.getElementById("extract-password");
        const extractButton = document.getElementById("extract-button");
        const extractStatus = document.getElementById("extract-status");
        const extractPreview = document.getElementById("extract-preview");
        const extractOutput = document.getElementById("extract-output");

        let embedImage = null;
        let extractImage = null;

        function refreshEmbedStats() {
            if (!embedImage) {
                embedStats.innerHTML = "<span>等待图片</span>";
                return;
            }
            const shape = getImageShape(embedImage);
            const textLength = encoder.encode(embedTextInput.value || "").length;
            embedStats.innerHTML = [
                `<span>尺寸 ${embedImage.width} × ${embedImage.height}</span>`,
                `<span>可写入约 ${getCapacity(embedImage)} 字节</span>`,
                `<span>当前内容 ${textLength} 字节</span>`,
                `<span>建议下载 PNG</span>`
            ].join("");
            if (shape.blockRows * shape.blockCols <= META_BITS * META_REPEAT) {
                embedStats.innerHTML = `<span>图片过小，请换更大的图片</span>`;
            }
        }

        embedImageInput.addEventListener("change", async () => {
            const file = (embedImageInput.files || [])[0];
            downloadLink.classList.add("disabled");
            downloadLink.href = "#";
            if (!file) {
                embedImage = null;
                refreshEmbedStats();
                setStatus(embedStatus, "尚未开始。");
                return;
            }
            try {
                embedImage = await loadImageFromFile(file);
                drawPreview(sourcePreview, embedImage);
                refreshEmbedStats();
                setStatus(embedStatus, "原图已载入。", "success");
            } catch (error) {
                embedImage = null;
                setStatus(embedStatus, error.message, "error");
            }
        });

        embedTextInput.addEventListener("input", refreshEmbedStats);

        embedButton.addEventListener("click", async () => {
            try {
                if (!embedImage) {
                    throw new Error("请先选择原图。");
                }
                if (!embedPasswordInput.value) {
                    throw new Error("请输入密码。");
                }
                setStatus(embedStatus, "处理中，请稍候。");
                const outputData = await transformImageWithWatermark(
                    getImageData(embedImage),
                    embedTextInput.value,
                    embedPasswordInput.value,
                    (progress) => setStatus(embedStatus, `${progress.label} ${Math.max(1, Math.round(progress.current / progress.total * 100))}%`)
                );
                const canvas = document.createElement("canvas");
                setCanvasImageData(canvas, outputData);
                drawPreview(resultPreview, canvas);
                downloadLink.href = canvas.toDataURL("image/png");
                downloadLink.classList.remove("disabled");
                setStatus(embedStatus, "处理完成。", "success");
            } catch (error) {
                setStatus(embedStatus, error.message, "error");
            }
        });

        extractImageInput.addEventListener("change", async () => {
            const file = (extractImageInput.files || [])[0];
            if (!file) {
                extractImage = null;
                extractOutput.value = "";
                setStatus(extractStatus, "尚未开始。");
                return;
            }
            try {
                extractImage = await loadImageFromFile(file);
                drawPreview(extractPreview, extractImage);
                extractOutput.value = "";
                setStatus(extractStatus, "图片已载入。", "success");
            } catch (error) {
                extractImage = null;
                setStatus(extractStatus, error.message, "error");
            }
        });

        extractButton.addEventListener("click", async () => {
            try {
                if (!extractImage) {
                    throw new Error("请先上传图片。");
                }
                if (!extractPasswordInput.value) {
                    throw new Error("请输入密码。");
                }
                setStatus(extractStatus, "处理中，请稍候。");
                extractOutput.value = await extractWatermarkText(
                    getImageData(extractImage),
                    extractPasswordInput.value,
                    (progress) => setStatus(extractStatus, `${progress.label} ${Math.max(1, Math.round(progress.current / progress.total * 100))}%`)
                );
                setStatus(extractStatus, "提取完成。", "success");
            } catch (error) {
                extractOutput.value = "";
                setStatus(extractStatus, error.message, "error");
            }
        });

        refreshEmbedStats();
    }

    if (typeof window !== "undefined" && typeof document !== "undefined") {
        window.addEventListener("DOMContentLoaded", setupPage);
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = {
            transformImageWithWatermark,
            extractWatermarkText,
            getCapacity,
            getImageShape,
            composeMeta,
            parseMeta
        };
    }
}());
