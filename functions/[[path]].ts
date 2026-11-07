import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

interface Env {
  S3_BUCKET: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
});

export async function onRequest(
  context: EventContext<Env, string, unknown>
) {
  const { request, env } = context;

  const BUCKET = env.S3_BUCKET;
  const ENDPOINT = env.S3_ENDPOINT;
  const REGION = env.S3_REGION;

  const s3 = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    region: REGION,
  });

  function buildObjectUrl(key = "") {
    const endpoint = ENDPOINT.replace(/\/$/, "");

    if (!key) {
      return `${endpoint}/${BUCKET}`;
    }

    const encodedKey = key
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    return `${endpoint}/${BUCKET}/${encodedKey}`;
  }

  async function signedFetch(
    url: string,
    init: RequestInit = {}
  ) {
    const signedRequest = await s3.sign(
      new Request(url, init),
      {
        aws: {
          service: "s3",
          region: REGION,
        },
      }
    );

    return fetch(signedRequest);
  }

  try {
    const url = new URL(request.url);

    const key = decodeURIComponent(
      url.pathname.replace(/^\/+/, "")
    );

    console.log({
      method: request.method,
      path: key,
      depth: request.headers.get("depth"),
      range: request.headers.get("range"),
      contentLength: request.headers.get(
        "content-length"
      ),
      userAgent: request.headers.get(
        "user-agent"
      ),
    });

    switch (request.method) {
      case "OPTIONS":
        return handleOptions();

      case "HEAD":
        return handleHead(key);

      case "GET":
        return handleGet(request, key);

      case "PROPFIND":
        return handlePropfind(request, key);

      default:
        return new Response(
          "Method Not Allowed",
          {
            status: 405,
            headers: {
              Allow:
                "OPTIONS, HEAD, GET, PROPFIND",
            },
          }
        );
    }
  } catch (err) {
    console.error("[webdav]", err);

    return new Response(
      JSON.stringify({
        error:
          err instanceof Error
            ? err.message
            : String(err),
      }),
      {
        status: 500,
        headers: {
          "Content-Type":
            "application/json",
        },
      }
    );
  }

  function handleOptions() {
    return new Response(null, {
      status: 200,
      headers: {
        DAV: "1",
        Allow:
          "OPTIONS, HEAD, GET, PROPFIND",
        "MS-Author-Via": "DAV",
        "Accept-Ranges": "bytes",
      },
    });
  }

  async function handleHead(
    key: string
  ) {
    if (!key) {
      return new Response(null, {
        status: 200,
      });
    }

    const response =
      await signedFetch(
        buildObjectUrl(key),
        {
          method: "HEAD",
        }
      );

    const headers = new Headers();

    copyHeader(
      response,
      headers,
      "content-length"
    );

    copyHeader(
      response,
      headers,
      "content-type"
    );

    copyHeader(
      response,
      headers,
      "etag"
    );

    copyHeader(
      response,
      headers,
      "last-modified"
    );

    headers.set(
      "Accept-Ranges",
      "bytes"
    );

    return new Response(null, {
      status: response.status,
      headers,
    });
  }

  async function handleGet(
    request: Request,
    key: string
  ) {
    if (!key) {
      return new Response(
        "WebDAV Root",
        {
          status: 200,
        }
      );
    }

    const requestHeaders =
      new Headers();

    const range =
      request.headers.get("range");

    if (range) {
      requestHeaders.set(
        "Range",
        range
      );
    }

    const response =
      await signedFetch(
        buildObjectUrl(key),
        {
          method: "GET",
          headers: requestHeaders,
        }
      );

    const headers = new Headers();

    [
      "content-length",
      "content-type",
      "content-range",
      "etag",
      "last-modified",
      "cache-control",
    ].forEach((name) => {
      copyHeader(
        response,
        headers,
        name
      );
    });

    headers.set(
      "Accept-Ranges",
      "bytes"
    );

    return new Response(
      response.body,
      {
        status: response.status,
        headers,
      }
    );
  }

  async function handlePropfind(
    request: Request,
    key: string
  ) {
    const depth =
      request.headers.get(
        "depth"
      ) ?? "1";

    const prefix =
      key.length === 0
        ? ""
        : key.endsWith("/")
        ? key
        : `${key}/`;

    const params =
      new URLSearchParams();

    params.set("list-type", "2");
    params.set("delimiter", "/");

    if (prefix) {
      params.set(
        "prefix",
        prefix
      );
    }

    const response =
      await signedFetch(
        `${buildObjectUrl()}?${params}`,
        {
          method: "GET",
        }
      );

    if (!response.ok) {
      return new Response(
        await response.text(),
        {
          status: response.status,
        }
      );
    }

    const xml =
      await response.text();

    const parsed =
      xmlParser.parse(xml);

    const bucketResult =
      parsed.ListBucketResult ??
      {};

    const folders =
      toArray(
        bucketResult.CommonPrefixes
      );

    const files =
      toArray(
        bucketResult.Contents
      );

    const responses: string[] = [];

    responses.push(`
<D:response>
  <D:href>/${escapeXml(prefix)}</D:href>
  <D:propstat>
    <D:prop>
      <D:displayname>${escapeXml(
        prefix || "/"
      )}</D:displayname>
      <D:resourcetype>
        <D:collection/>
      </D:resourcetype>
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`);

    if (depth === "1") {
      for (const folder of folders) {
        responses.push(`
<D:response>
<D:href>/${escapeXml(folder.Prefix ?? "")}</D:href>
<D:propstat>
<D:prop>
<D:displayname>${escapeXml(folder.Prefix ?? "")}</D:displayname>
<D:resourcetype><D:collection/></D:resourcetype>
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>`);
      }

      for (const file of files) {
        const fileKey =
          file.Key ?? "";

        if (
          !fileKey ||
          fileKey === prefix
        ) {
          continue;
        }

        responses.push(`
<D:response>
<D:href>/${escapeXml(fileKey)}</D:href>
<D:propstat>
<D:prop>
<D:displayname>${escapeXml(fileKey)}</D:displayname>
<D:getcontentlength>${file.Size ?? 0}</D:getcontentlength>
<D:getlastmodified>${file.LastModified ?? ""}</D:getlastmodified>
<D:resourcetype/>
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>`);
      }
    }

    return new Response(
      `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses.join("\n")}
</D:multistatus>`,
      {
        status: 207,
        headers: {
          DAV: "1",
          "Content-Type":
            "application/xml; charset=utf-8",
        },
      }
    );
  }
}

function toArray<T>(
  value: T | T[] | undefined
): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value)
    ? value
    : [value];
}

function copyHeader(
  source: Response,
  target: Headers,
  name: string
) {
  const value =
    source.headers.get(name);

  if (value) {
    target.set(name, value);
  }
}

function escapeXml(
  value: string
) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
