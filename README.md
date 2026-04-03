# LinkedIn MCP Server

MCP сервер для интеграции с LinkedIn API. Позволяет публиковать контент, управлять профилем и просматривать аналитику прямо из Claude.

## Возможности

| Инструмент | Описание |
|---|---|
| `linkedin_get_profile` | Получить данные своего профиля |
| `linkedin_get_positions` | Список позиций (опыт работы) |
| `linkedin_update_position` | Обновить позицию в профиле |
| `linkedin_create_post` | Опубликовать пост (текст или с картинкой) |
| `linkedin_get_post` | Получить данные поста по URN |
| `linkedin_delete_post` | Удалить пост |
| `linkedin_upload_image` | Загрузить изображение для поста |
| `linkedin_get_org_analytics` | Аналитика страницы компании |
| `linkedin_get_post_analytics` | Аналитика постов |

---

## Настройка

### 1. Создай приложение LinkedIn

1. Перейди на [developer.linkedin.com](https://developer.linkedin.com)
2. Создай новое приложение
3. В разделе **Products** добавь:
   - **Sign In with LinkedIn using OpenID Connect** — для базового профиля
   - **Share on LinkedIn** — для публикации постов (`w_member_social`)
   - **Marketing Developer Platform** — для аналитики (опционально, требует одобрения)

### 2. Получи OAuth токен

LinkedIn использует **3-legged OAuth 2.0**. Нужные scopes:

```
profile w_member_social r_organization_social
```

Простой способ получить токен через [LinkedIn Token Inspector](https://www.linkedin.com/developers/tools/oauth/token-inspector) или через OAuth flow своего приложения.

### 3. Установи переменную окружения

```bash
export LINKEDIN_ACCESS_TOKEN=AQX...ваш_токен...
```

### 4. Подключи к Claude

Добавь в конфиг MCP (например `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "node",
      "args": ["/path/to/linkedin-mcp-server/dist/index.js"],
      "env": {
        "LINKEDIN_ACCESS_TOKEN": "AQX...ваш_токен..."
      }
    }
  }
}
```

---

## Использование

### Публикация поста

```
Опубликуй в LinkedIn: "Рады сообщить о запуске нашего нового продукта! 🚀"
```

### Пост с картинкой

```
1. Загрузи /Users/me/photo.jpg в LinkedIn
2. Опубликуй пост с этой картинкой и текстом "Отличное мероприятие!"
```

### Аналитика страницы компании

```
Покажи аналитику страницы urn:li:organization:12345678 за последние 30 дней
```

---

## Ограничения LinkedIn API

- **Редактирование профиля**: LinkedIn разрешает менять только ограниченный набор полей через API (позиции с numeric ID). Большинство полей профиля можно редактировать только вручную.
- **Аналитика постов**: Полная аналитика требует одобрения в **Marketing Developer Platform** — отдельный процесс верификации от LinkedIn.
- **Аналитика личного профиля**: LinkedIn не предоставляет аналитику личных постов через API — только для страниц компаний.
- **Rate limits**: ~100–500 запросов/день в зависимости от endpoint.
- **Срок токена**: Access token живёт ~60 дней, после нужно обновить.

---

## Сборка из исходников

```bash
npm install
npm run build
node dist/index.js
```

## Разработка

```bash
npm run dev   # tsx watch — hot reload
```
