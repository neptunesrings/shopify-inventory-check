const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const corsOption = {
    origin: process.env.SHOPIFY_SITE_URL,
    optionsSuccessStatus: 200,
}
app.use(cors(corsOption));
app.use(express.json());  // Ensures JSON request bodies are parsed
app.use(express.urlencoded({ extended: true })); // Parses URL-encoded form data

const SHOPIFY_API_URL = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/`;
const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;

app.get('/inventory-levels', async(req, res) => {
    const { variant_id, location_id } = req.query;

    if (!variant_id || !location_id) {
        return res.status(400).json({ error: 'Missing Variant or Location ID parameters.' });
    }

    try {
        // Step 1: Get inventory item is using variant_id
        const variantResponse = await fetch(`${SHOPIFY_API_URL}variants/${variant_id}.json`,{
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
        });

        if (!variantResponse.ok) {
            const errorText = await variantResponse.text();
            console.error(`Shopify API Error (Variant): ${variantResponse.status} ${variantResponse.statusText}`, errorText);
            return res.status(variantResponse.status).json({ error: `Shopify API Error: ${variantResponse.statusText}` });
        }

        const variantData = await variantResponse.json();
        const inventory_item_id = variantData.variant.inventory_item_id;

        // Step 2: Get inventory levels using inventory_item_id and location_id
        const inventoryResponse = await fetch(`${SHOPIFY_API_URL}inventory_levels.json?inventory_item_ids=${inventory_item_id}&location_ids=${location_id}`,{
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
        });

        if (!inventoryResponse.ok) {
            const errorText = await inventoryResponse.text();
            console.error(`Shopify API Error (Inventory): ${inventoryResponse.status} ${inventoryResponse.statusText}`, errorText);
            return res.status(inventoryResponse.status).json({ error: `Shopify API Error: ${inventoryResponse.statusText}` });
        }

        const inventoryData = await inventoryResponse.json();
        res.json(inventoryData);
    } catch (error) {
        console.error('Unexpected Error:', error.message);
        res.status(500).json({ error: error.message });
    }

});

app.post('/webhook/inventory-update', async(req, res) => {
    console.log("Webhook received:", req.body); // Debugging
    if (!req.body || Object.keys(req.body).length === 0) {
        console.error("❌ Missing request body");
        return res.status(400).json({ error: "Missing request body" });
    }

    const { location_id, inventory_item_id, available } = req.body;

    try {
        console.log("Fetching Product ID...");
        const inventoryItemGID = `gid://shopify/InventoryItem/${inventory_item_id}`;

        const query = `
            query GetProductAndVariantFromInventoryItem($inventoryItemGID: ID!) {
                inventoryItem(id: $inventoryItemGID) {
                    id
                    variant {
                        id
                        title
                        product {
                            id
                            title
                            tags
                        }
                    }
                }
            }
        `;

        const responseData = await shopifyGraphQLRequest(query, { inventoryItemGID });

        // Extract product_id and variant_id
        const productId = responseData?.data?.inventoryItem?.variant?.product?.id;
        const variantId = responseData?.data?.inventoryItem?.variant?.id;
        const productTags = responseData?.data?.inventoryItem?.variant?.product?.tags || "";

        console.log("Product ID:", productId);
        console.log("Variant ID:", variantId);
        console.log("Existing Tags:", productTags);

        if (!productId) {
            console.error("❌ No Product ID found for Inventory Item:", inventory_item_id);
            return res.status(400).send("Product ID not found");
        }

        // If from "sev warehouse" and inventory is greater than 0 → Add tag
        if (String(location_id) === "96970244422" && available > 0 && !productTags.includes("stockfromretours")) {
            console.log("Adding 'stockfromretours' tag to product...");
            await addProductTag(productId);
        }

        // If from "sev warehouse" and inventory is 0 → Check other variants and Remove tag
        if (String(location_id) === "96970244422" && available === 0 && productTags.includes("stockfromretours")) {
            console.log("Check if product has other variants in stockfromretours...");
            await checkAndHandleStock(productId);
        }

        res.status(200).send("Webhook processed");

    } catch (error) {
        console.error("Error updating product tag:", error);
        res.status(500).send("Error processing webhook");
    }
});

/**
 * Function to check if product has other variants in 96970244422 location
 */
async function checkAndHandleStock(productId) {
    const locationId = "gid://shopify/Location/96970244422"; // Shopify uses global IDs
    let allVariantsOutOfStock = true;

    // Step 1: Fetch all variants for the product
    const productVariantsResponse = await shopifyGraphQLRequest(
        `
        query GetProductVariants($productId: ID!) {
            product(id: $productId) {
                variants(first: 50) {
                    edges {
                        node {
                            id
                            inventoryItem {
                                id
                            }
                        }
                    }
                }
            }
        }
        `,
        { productId }
    );

    const variants = productVariantsResponse.data.product.variants.edges;
    console.log(`Found ${variants.length} variants for product ${productId}`);

    // Step 2: Check inventory levels for each variant at the given location
    for (const variant of variants) {
        const inventoryItemId = variant.node.inventoryItem.id;

        const inventoryResponse = await shopifyGraphQLRequest(
            `
            query GetInventoryLevels($inventoryItemId: ID!) {
                inventoryItem(id: $inventoryItemId) {
                    inventoryLevels(first: 10) {
                        edges {
                            node {
                                quantities(names: ["available"]) {
                                    name
                                    quantity
                                }
                                location {
                                    id
                                    name
                                }
                            }
                        }
                    }
                }
            }
            `,
            { inventoryItemId }
        );

        // Filter the results programmatically to match a specific location
        const filteredInventory = inventoryResponse?.data?.inventoryItem?.inventoryLevels?.edges
        .map(edge => edge.node)
        .find(node => node.location.id === locationId);
        const available = filteredInventory?.quantities?.find(q => q.name === "available")?.quantity || 0;

        console.log("filteredInventory: ", filteredInventory); // This will contain the matching inventory level for the location
        console.log("available quantity is: ", available);

        if (available > 0) {
            allVariantsOutOfStock = false; // At least one variant is still in stock
            break;
        }
    }

    // If all variants are out of stock, apply logic (e.g., removing tag)
    if (allVariantsOutOfStock) {
        console.log("All variants are out of stock. Removing 'stockfromretours' tag...");
        await removeProductTag(productId, 'stockfromretours');
    } else {
        console.log("At least one variant is still in stock. No action needed.");
    }
}

/**
 * Function to add a tag to a product if it doesn't exist
 */
async function addProductTag(productId) {
    const mutationQuery = `
        mutation AddTagsToProduct($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) {
                node {
                    id
                }
                userErrors {
                    message
                }
            }
        }
    `;

    const responseData = await shopifyGraphQLRequest(mutationQuery, {
        id: productId,
        tags: ["stockfromretours"]
    });

    if (responseData?.data?.tagsAdd?.userErrors.length > 0) {
        console.error("Shopify User Errors:", responseData.data.tagsAdd.userErrors);
        return;
    }

    console.log("Tag added successfully!");
}

async function removeProductTag(productId, tagToRemove) {
    const mutationQuery = `
        mutation RemoveTagsFromProduct($id: ID!, $tags: [String!]!) {
            tagsRemove(id: $id, tags: $tags) {
                node {
                    id
                }
                userErrors {
                    message
                }
            }
        }
    `;

    const responseData = await shopifyGraphQLRequest(mutationQuery, {
        id: productId,
        tags: [tagToRemove]
    });

    if (responseData?.data?.tagsRemove?.userErrors.length > 0) {
        console.error("Shopify User Errors:", responseData.data.tagsRemove.userErrors);
        return;
    }

    console.log("Tag removed successfully!");
}

// Helper function to send GraphQL requests to Shopify
async function shopifyGraphQLRequest(query, variables = {}) {
    try {
        const response = await fetch(`${SHOPIFY_API_URL}/graphql.json`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN
            },
            body: JSON.stringify({ query, variables })
        });

        const responseData = await response.json();
        console.log("GraphQL Response:", JSON.stringify(responseData, null, 2));

        return responseData;
    } catch (error) {
        console.error("Error in GraphQL request:", error);
        throw error;
    }
}

app.listen(port, () => {
   console.log(`Server is running on port ${port}`);
});