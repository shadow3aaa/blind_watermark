(function () {
    "use strict";

    const MAGIC = [0x42, 0x57, 0x4d, 0x31];
    const HEADER_BYTES = 12;
    const PREVIEW_MAX = 640;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function hashPassword(input) {
        let hash = 2166136261 >>> 0;
        const value = String(input || "");
        for (let i = 0; i < value.length; i += 1) {
            hash ^= value.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
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

    function buildShuffledIndices(size, seed) {
        const indices = new Uint32Array(size);
        for (let i = 0; i < size; i += 1) {
            indices[i] = i;
        }
        const random = mulberry32(seed || 1);
        for (let i = size - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            const value = indices[i];
            indices[i] = indices[j];
            indices[j] = value;
        }
        return indices;
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
        return [
            (value >>> 24) & 255,
            (value >>> 16) & 255,
            (value >>> 8) & 255,
            value & 255
        ];
    }

    function bytesToNumber(bytes, offset) {
        return (
            ((bytes[offset] << 24) >>> 0) +
            ((bytes[offset + 1] << 16) >>> 0) +
            ((bytes[offset + 2] << 8) >>> 0) +
            (bytes[offset + 3] >>> 0)
        ) >>> 0;
    }

    function bytesToBits(bytes) {
        const bits = new Uint8Array(bytes.length * 8);
        for (let i = 0; i < bytes.length; i += 1) {
            const value = bytes[i];
            for (let bit = 0; bit < 8; bit += 1) {
                bits[i * 8 + bit] = (value >> (7 - bit)) & 1;
            }
        }
        return bits;
    }

    function bitsToBytes(bits) {
        const byteLength = Math.ceil(bits.length / 8);
        const bytes = new Uint8Array(byteLength);
        for (let i = 0; i < bits.length; i += 1) {
            bytes[Math.floor(i / 8)] = (bytes[Math.floor(i / 8)] << 1) | bits[i];
            if (i % 8 === 7) {
                bytes[Math.floor(i / 8)] &= 255;
            }
        }
        const remaining = bits.length % 8;
        if (remaining !== 0) {
            bytes[byteLength - 1] <<= (8 - remaining);
            bytes[byteLength - 1] &= 255;
        }
        return bytes;
    }

    function composePayload(text) {
        const messageBytes = encoder.encode(text);
        const payload = new Uint8Array(HEADER_BYTES + messageBytes.length);
        payload.set(MAGIC, 0);
        payload.set(numberToBytes(messageBytes.length), 4);
        payload.set(numberToBytes(checksum(messageBytes)), 8);
        payload.set(messageBytes, HEADER_BYTES);
        return payload;
    }

    function parsePayload(bytes) {
        for (let i = 0; i < MAGIC.length; i += 1) {
            if (bytes[i] !== MAGIC[i]) {
                throw new Error("未识别到有效水印。请检查图片是否来自本页面，或密码是否正确。");
            }
        }

        const messageLength = bytesToNumber(bytes, 4);
        const expectedChecksum = bytesToNumber(bytes, 8);
        const actualMessage = bytes.slice(HEADER_BYTES, HEADER_BYTES + messageLength);

        if (actualMessage.length !== messageLength) {
            throw new Error("水印数据不完整，可能被压缩或破坏。");
        }
        if (checksum(actualMessage) !== expectedChecksum) {
            throw new Error("水印校验失败。图片可能经过二次压缩，或者密码不匹配。");
        }
        return decoder.decode(actualMessage);
    }

    function getCapacity(pixelCount) {
        return Math.floor(pixelCount / 8) - HEADER_BYTES;
    }

    function embedText(imageData, text, password) {
        const payload = composePayload(text);
        const bits = bytesToBits(payload);
        const pixelCount = imageData.width * imageData.height;
        const capacity = getCapacity(pixelCount);

        if (payload.length > capacity) {
            throw new Error(`图片容量不足，最多可嵌入约 ${capacity} 字节。`);
        }

        const output = new ImageData(
            new Uint8ClampedArray(imageData.data),
            imageData.width,
            imageData.height
        );
        const positions = buildShuffledIndices(pixelCount, hashPassword(password));

        for (let i = 0; i < bits.length; i += 1) {
            const pixelIndex = positions[i];
            const blueIndex = pixelIndex * 4 + 2;
            output.data[blueIndex] = (output.data[blueIndex] & 0xfe) | bits[i];
        }

        return output;
    }

    function extractText(imageData, password) {
        const pixelCount = imageData.width * imageData.height;
        const positions = buildShuffledIndices(pixelCount, hashPassword(password));
        const headerBits = new Uint8Array(HEADER_BYTES * 8);

        for (let i = 0; i < headerBits.length; i += 1) {
            const pixelIndex = positions[i];
            headerBits[i] = imageData.data[pixelIndex * 4 + 2] & 1;
        }

        const headerBytes = bitsToBytes(headerBits);
        for (let i = 0; i < MAGIC.length; i += 1) {
            if (headerBytes[i] !== MAGIC[i]) {
                throw new Error("未识别到有效水印。请确认密码正确，并尽量使用未压缩的 PNG 图片。");
            }
        }

        const messageLength = bytesToNumber(headerBytes, 4);
        const totalBytes = HEADER_BYTES + messageLength;
        if (totalBytes > Math.floor(pixelCount / 8)) {
            throw new Error("图片中的数据长度异常，无法安全提取。");
        }

        const bits = new Uint8Array(totalBytes * 8);
        for (let i = 0; i < bits.length; i += 1) {
            const pixelIndex = positions[i];
            bits[i] = imageData.data[pixelIndex * 4 + 2] & 1;
        }

        return parsePayload(bitsToBytes(bits));
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
        const width = source.width;
        const height = source.height;
        if (!width || !height) {
            return;
        }

        const ratio = Math.min(PREVIEW_MAX / width, PREVIEW_MAX / height, 1);
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
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
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
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
            const capacity = getCapacity(embedImage.width * embedImage.height);
            const textLength = encoder.encode(embedTextInput.value || "").length;
            embedStats.innerHTML = [
                `<span>尺寸 ${embedImage.width} × ${embedImage.height}</span>`,
                `<span>可嵌入约 ${capacity} 字节</span>`,
                `<span>当前文字 ${textLength} 字节</span>`
            ].join("");
        }

        embedImageInput.addEventListener("change", async () => {
            const [file] = embedImageInput.files || [];
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

        embedButton.addEventListener("click", () => {
            try {
                if (!embedImage) {
                    throw new Error("请先选择原图。");
                }
                if (!embedTextInput.value.trim()) {
                    throw new Error("请输入要嵌入的文字水印。");
                }
                if (!embedPasswordInput.value) {
                    throw new Error("请输入密码。");
                }

                const inputData = getImageData(embedImage);
                const outputData = embedText(inputData, embedTextInput.value, embedPasswordInput.value);

                const fullCanvas = document.createElement("canvas");
                setCanvasImageData(fullCanvas, outputData);
                drawPreview(resultPreview, fullCanvas);
                downloadLink.href = fullCanvas.toDataURL("image/png");
                downloadLink.classList.remove("disabled");
                setStatus(embedStatus, "已生成带水印图片，可直接下载 PNG。", "success");
            } catch (error) {
                setStatus(embedStatus, error.message, "error");
            }
        });

        extractImageInput.addEventListener("change", async () => {
            const [file] = extractImageInput.files || [];
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
                setStatus(extractStatus, "待提取图片已载入。", "success");
            } catch (error) {
                extractImage = null;
                setStatus(extractStatus, error.message, "error");
            }
        });

        extractButton.addEventListener("click", () => {
            try {
                if (!extractImage) {
                    throw new Error("请先上传带水印图片。");
                }
                if (!extractPasswordInput.value) {
                    throw new Error("请输入密码。");
                }

                const imageData = getImageData(extractImage);
                const message = extractText(imageData, extractPasswordInput.value);
                extractOutput.value = message;
                setStatus(extractStatus, "提取成功。", "success");
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
            embedText,
            extractText,
            composePayload,
            parsePayload,
            getCapacity,
            hashPassword
        };
    }
}());
