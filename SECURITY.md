# Security

Please report vulnerabilities privately through this repository's GitHub **Security → Report a vulnerability** flow. Avoid public issues containing exploit details, personal data or secrets. Include affected paths, expected behavior and a minimal reproduction using synthetic local data.

Do not probe the live service or submit load-test traffic, fake supporters or synthetic messages to it. Use the local in-memory server for testing. Never reuse its development token in production.

Operators must configure their own ADMIN_TOKEN and RATE_SALT secrets. The admin page and API require the administrative token; displaying the page alone does not grant access. Keep production configuration, database exports and moderation records outside Git. Review dependency updates and recipient donation links before deploying.
