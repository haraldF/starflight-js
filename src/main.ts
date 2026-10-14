

async function loadStar(url: string)
{
    const response = await fetch(url);
    const data = await response.arrayBuffer();
    return data;
}

async function main()
{
    const [ stara, starb ] = await Promise.all([
        loadStar('STARA.COM'),
        loadStar('STARB.COM')
    ]);

    console.log("downloaded", stara.byteLength, starb.byteLength);
}

main().catch(console.error);