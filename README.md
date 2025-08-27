# E2Open TMS Automation API

Express.js API that automates E2Open TMS operations with persistent browser sessions and PDF generation.

## Features

- Header-based action routing (`x-action`, `x-load-number`)
- Persistent browser sessions (30-minute timeout)
- Automatic re-login detection
- Binary PDF response
- Automatic file cleanup after response

## Environment Variables

Required in `.env` or Coolify:
- `TMS_USERNAME` - E2Open username
- `TMS_PASSWORD` - E2Open password

Optional:
- `PORT` - Default: 3952
- `HEADLESS` - Default: true
- `PDF_SAVE_PATH` - Default: /app/temp

## API Usage

```bash
curl -X POST http://localhost:3952/api/automation \
  -H "x-action: printloadconfirmation" \
  -H "x-load-number: 194828381" \
  -OJ
```

Returns: PDF file named `RATECON MULDER BROTHERS [load] [MM.DD.YY].pdf`

## Endpoints

- `GET /health` - Health check with session status
- `GET /api/session` - Check browser session
- `POST /api/session/reset` - Force new session
- `POST /api/automation` - Run automation (requires headers)

## Docker Deployment

```bash
docker-compose up --build
```

## Coolify Deployment

1. Push to GitHub
2. Create new Coolify application
3. Set environment variables:
   - `TMS_USERNAME`
   - `TMS_PASSWORD`
4. Add persistent storage: `/app/temp`

Port 3952 is pre-configured.